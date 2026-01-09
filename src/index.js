const core = require('@actions/core');
const github = require('@actions/github');
const Anthropic = require('@anthropic-ai/sdk');

async function lookupSlackUserByEmail(botToken, email) {
  const response = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
    headers: {
      'Authorization': `Bearer ${botToken}`,
    },
  });
  const data = await response.json();
  if (data.ok) {
    return data.user;
  }
  return null;
}

async function sendSlackDM(botToken, userId, blocks) {
  // Open a DM channel with the user
  const openResponse = await fetch('https://slack.com/api/conversations.open', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ users: userId }),
  });
  const openData = await openResponse.json();

  if (!openData.ok) {
    throw new Error(`Failed to open DM: ${openData.error}`);
  }

  const channelId = openData.channel.id;

  // Send the message
  const msgResponse = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: channelId,
      blocks: blocks,
    }),
  });
  const msgData = await msgResponse.json();

  if (!msgData.ok) {
    throw new Error(`Failed to send DM: ${msgData.error}`);
  }

  return msgData;
}

async function sendSlackChannel(botToken, channelId, blocks) {
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: channelId,
      blocks: blocks,
    }),
  });
  const data = await response.json();

  if (!data.ok) {
    throw new Error(`Failed to send to channel: ${data.error}`);
  }

  return data;
}

async function sendSlackWebhook(webhookUrl, blocks) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ blocks }),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook failed: ${response.status} ${response.statusText}`);
  }

  return response;
}

async function run() {
  try {
    // Get inputs
    const githubToken = core.getInput('github_token', { required: true });
    const anthropicApiKey = core.getInput('anthropic_api_key', { required: true });
    const slackBotToken = core.getInput('slack_bot_token');
    const slackWebhookUrl = core.getInput('slack_webhook_url');
    const notificationMode = core.getInput('notification_mode') || 'channel';
    const fallbackChannel = core.getInput('fallback_channel');
    const runId = core.getInput('run_id') || github.context.runId;
    const maxLogLines = parseInt(core.getInput('max_log_lines') || '500', 10);
    const claudeModel = core.getInput('claude_model') || 'claude-sonnet-4-20250514';

    // Validate inputs based on mode
    if (notificationMode === 'dm' && !slackBotToken) {
      core.setFailed('slack_bot_token is required for DM mode');
      return;
    }
    if (notificationMode === 'channel' && !slackWebhookUrl && !slackBotToken) {
      core.setFailed('slack_webhook_url or slack_bot_token is required for channel mode');
      return;
    }

    const { owner, repo } = github.context.repo;
    const octokit = github.getOctokit(githubToken);

    core.info(`Analyzing workflow run ${runId} in ${owner}/${repo}`);

    // Fetch workflow run details
    const { data: workflowRun } = await octokit.rest.actions.getWorkflowRun({
      owner,
      repo,
      run_id: parseInt(runId, 10),
    });

    // Get commit author email
    const committerEmail = workflowRun.head_commit?.author?.email;
    const committerName = workflowRun.head_commit?.author?.name || 'Unknown';
    core.info(`Commit author: ${committerName} <${committerEmail}>`);

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
Author: ${committerName}
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

    // Build Slack message blocks
    const blocks = [
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
    ];

    // Send notification based on mode
    if (notificationMode === 'dm') {
      core.info('Notification mode: DM to committer');

      let slackUser = null;
      if (committerEmail) {
        slackUser = await lookupSlackUserByEmail(slackBotToken, committerEmail);
      }

      if (slackUser) {
        core.info(`Found Slack user: ${slackUser.name} (${slackUser.id})`);
        await sendSlackDM(slackBotToken, slackUser.id, blocks);
        core.setOutput('notified_user', slackUser.id);
        core.info(`DM sent to ${slackUser.name}`);
      } else {
        core.warning(`Could not find Slack user for email: ${committerEmail}`);

        if (fallbackChannel) {
          core.info(`Falling back to channel: ${fallbackChannel}`);
          await sendSlackChannel(slackBotToken, fallbackChannel, blocks);
          core.info('Message sent to fallback channel');
        } else {
          core.setFailed('Could not find Slack user and no fallback channel configured');
          return;
        }
      }
    } else {
      // Channel mode
      core.info('Notification mode: Channel');

      if (slackWebhookUrl) {
        await sendSlackWebhook(slackWebhookUrl, blocks);
      } else if (slackBotToken && fallbackChannel) {
        await sendSlackChannel(slackBotToken, fallbackChannel, blocks);
      }

      core.info('Summary posted to Slack channel');
    }

  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
