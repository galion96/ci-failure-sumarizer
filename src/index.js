const core = require('@actions/core');
const github = require('@actions/github');
const Anthropic = require('@anthropic-ai/sdk');

async function run() {
  try {
    // Get inputs
    const githubToken = core.getInput('github_token', { required: true });
    const anthropicApiKey = core.getInput('anthropic_api_key', { required: true });
    const slackWebhookUrl = core.getInput('slack_webhook_url', { required: true });
    const runId = core.getInput('run_id') || github.context.runId;
    const maxLogLines = parseInt(core.getInput('max_log_lines') || '500', 10);
    const claudeModel = core.getInput('claude_model') || 'claude-sonnet-4-20250514';
    const includeLogSnippet = core.getInput('include_log_snippet') !== 'false';

    const { owner, repo } = github.context.repo;
    const octokit = github.getOctokit(githubToken);

    core.info(`Analyzing workflow run ${runId} in ${owner}/${repo}`);

    // Fetch workflow run details
    const { data: workflowRun } = await octokit.rest.actions.getWorkflowRun({
      owner,
      repo,
      run_id: parseInt(runId, 10),
    });

    // Fetch jobs for this run
    const { data: jobsData } = await octokit.rest.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: parseInt(runId, 10),
    });

    // Find failed jobs
    const failedJobs = jobsData.jobs.filter(job => job.conclusion === 'failure');

    if (failedJobs.length === 0) {
      core.info('No failed jobs found in this workflow run');
      return;
    }

    core.info(`Found ${failedJobs.length} failed job(s)`);

    // Fetch logs for failed jobs
    let allLogs = '';
    for (const job of failedJobs) {
      core.info(`Fetching logs for job: ${job.name}`);

      try {
        const { data: logs } = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
          owner,
          repo,
          job_id: job.id,
        });

        allLogs += `\n\n=== Job: ${job.name} ===\n${logs}`;
      } catch (error) {
        core.warning(`Failed to fetch logs for job ${job.name}: ${error.message}`);
      }
    }

    if (!allLogs) {
      core.setFailed('Could not fetch any logs from failed jobs');
      return;
    }

    // Truncate logs if too long
    const logLines = allLogs.split('\n');
    const truncatedLogs = logLines.length > maxLogLines
      ? logLines.slice(-maxLogLines).join('\n')
      : allLogs;

    core.info(`Analyzing ${Math.min(logLines.length, maxLogLines)} lines of logs`);

    // Analyze with Claude
    const anthropic = new Anthropic({ apiKey: anthropicApiKey });

    const analysis = await anthropic.messages.create({
      model: claudeModel,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `You are a CI/CD expert. Analyze these GitHub Actions logs from a failed workflow run and provide a concise summary.

Repository: ${owner}/${repo}
Workflow: ${workflowRun.name}
Branch: ${workflowRun.head_branch}
Commit: ${workflowRun.head_sha.substring(0, 7)}
Failed Jobs: ${failedJobs.map(j => j.name).join(', ')}

LOGS:
${truncatedLogs}

Provide a response in this format:
1. **Root Cause**: One sentence explaining what caused the failure
2. **Error**: The specific error message (if identifiable)
3. **Suggested Fix**: Brief actionable suggestion to fix the issue
4. **Relevant Log Snippet**: The most relevant 3-5 lines from the logs (only if helpful)

Keep it concise - this will be posted to Slack. Focus on being helpful, not comprehensive.`
        }
      ]
    });

    const summary = analysis.content[0].text;
    core.info('Analysis complete');
    core.setOutput('summary', summary);

    // Send to Slack
    const slackPayload = {
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `CI Failed: ${workflowRun.name}`,
            emoji: true
          }
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Repository:*\n<https://github.com/${owner}/${repo}|${owner}/${repo}>`
            },
            {
              type: 'mrkdwn',
              text: `*Branch:*\n${workflowRun.head_branch}`
            },
            {
              type: 'mrkdwn',
              text: `*Commit:*\n<${workflowRun.head_commit?.url || '#'}|${workflowRun.head_sha.substring(0, 7)}>`
            },
            {
              type: 'mrkdwn',
              text: `*Failed Jobs:*\n${failedJobs.map(j => j.name).join(', ')}`
            }
          ]
        },
        {
          type: 'divider'
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: summary
          }
        },
        {
          type: 'divider'
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'View Workflow Run',
                emoji: true
              },
              url: workflowRun.html_url
            }
          ]
        }
      ]
    };

    const slackResponse = await fetch(slackWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(slackPayload),
    });

    if (!slackResponse.ok) {
      throw new Error(`Slack webhook failed: ${slackResponse.status} ${slackResponse.statusText}`);
    }

    core.info('Summary posted to Slack successfully');

  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
