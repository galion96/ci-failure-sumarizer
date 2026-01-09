const core = require('@actions/core');
const github = require('@actions/github');
const Anthropic = require('@anthropic-ai/sdk');
const Groq = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Default models for each provider
const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-20250514',
  groq: 'llama-3.3-70b-versatile',
  gemini: 'gemini-2.0-flash',
};

// Error keywords to search for in logs
const ERROR_KEYWORDS = [
  /\berror\b/i,
  /\bfailed\b/i,
  /\bfailure\b/i,
  /\bexception\b/i,
  /\bfatal\b/i,
  /\bcannot\b/i,
  /\bcould not\b/i,
  /\bunable to\b/i,
  /\bundefined\b/i,
  /\bnull\b/i,
  /\btimeout\b/i,
  /\bexit code [1-9]/i,
  /\bexited with\b/i,
  /\bnpm ERR!/,
  /\bTypeError\b/,
  /\bSyntaxError\b/,
  /\bReferenceError\b/,
  /\bAssertionError\b/,
  /\bENOENT\b/,
  /\bEACCES\b/,
  /\bsegmentation fault\b/i,
  /\bpanic\b/i,
  /\bstack trace\b/i,
  /\btraceback\b/i,
];

const CONTEXT_LINES = 5; // Lines before and after each match

function extractRelevantLogs(logs, maxLines) {
  const lines = logs.split('\n');
  const matchedLineIndices = new Set();

  // Find all lines that match error keywords
  lines.forEach((line, index) => {
    for (const pattern of ERROR_KEYWORDS) {
      if (pattern.test(line)) {
        // Add context lines around the match
        for (let i = Math.max(0, index - CONTEXT_LINES); i <= Math.min(lines.length - 1, index + CONTEXT_LINES); i++) {
          matchedLineIndices.add(i);
        }
        break;
      }
    }
  });

  // If no matches found, return null to signal fallback
  if (matchedLineIndices.size === 0) {
    return null;
  }

  // Sort indices and extract lines
  const sortedIndices = Array.from(matchedLineIndices).sort((a, b) => a - b);

  // Group consecutive lines and add separators
  const extractedLines = [];
  let lastIndex = -2;

  for (const index of sortedIndices) {
    if (index > lastIndex + 1 && extractedLines.length > 0) {
      extractedLines.push('... (skipped lines) ...');
    }
    extractedLines.push(lines[index]);
    lastIndex = index;
  }

  // Truncate if still too long
  if (extractedLines.length > maxLines) {
    return extractedLines.slice(-maxLines).join('\n');
  }

  return extractedLines.join('\n');
}

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

async function analyzeWithAI(provider, apiKey, model, prompt) {
  switch (provider) {
    case 'anthropic': {
      const anthropic = new Anthropic({ apiKey });
      const response = await anthropic.messages.create({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });
      return response.content[0].text;
    }

    case 'groq': {
      const groq = new Groq({ apiKey });
      const response = await groq.chat.completions.create({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });
      return response.choices[0].message.content;
    }

    case 'gemini': {
      const genAI = new GoogleGenerativeAI(apiKey);
      const geminiModel = genAI.getGenerativeModel({ model });
      const response = await geminiModel.generateContent(prompt);
      return response.response.text();
    }

    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

async function run() {
  try {
    // Get inputs
    const githubToken = core.getInput('github_token', { required: true });
    const provider = core.getInput('provider') || 'anthropic';
    const slackBotToken = core.getInput('slack_bot_token');
    const slackWebhookUrl = core.getInput('slack_webhook_url');
    const notificationMode = core.getInput('notification_mode') || 'channel';
    const fallbackChannel = core.getInput('fallback_channel');
    const runId = core.getInput('run_id') || github.context.runId;
    const maxLogLines = parseInt(core.getInput('max_log_lines') || '500', 10);

    // Get API key based on provider
    let apiKey;
    switch (provider) {
      case 'anthropic':
        apiKey = core.getInput('anthropic_api_key');
        break;
      case 'groq':
        apiKey = core.getInput('groq_api_key');
        break;
      case 'gemini':
        apiKey = core.getInput('gemini_api_key');
        break;
      default:
        core.setFailed(`Unknown provider: ${provider}. Use 'anthropic', 'groq', or 'gemini'`);
        return;
    }

    if (!apiKey) {
      core.setFailed(`${provider}_api_key is required when using the ${provider} provider`);
      return;
    }

    // Get model with provider-specific default
    const model = core.getInput('model') || DEFAULT_MODELS[provider];
    core.info(`Using provider: ${provider}, model: ${model}`);

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

    // Try to extract relevant logs using keyword matching
    let logsToAnalyze = extractRelevantLogs(allLogs, maxLogLines);
    let usedKeywordExtraction = true;

    if (logsToAnalyze) {
      core.info(`Extracted relevant log sections using keyword matching (${logsToAnalyze.split('\n').length} lines)`);
    } else {
      // Fallback to truncating from the end
      usedKeywordExtraction = false;
      const logLines = allLogs.split('\n');
      logsToAnalyze = logLines.length > maxLogLines
        ? logLines.slice(-maxLogLines).join('\n')
        : allLogs;
      core.info(`No keyword matches found, using last ${Math.min(logLines.length, maxLogLines)} lines`);
    }

    // Build the analysis prompt
    const prompt = `You are a CI/CD expert. Analyze these GitHub Actions logs from a failed workflow run and provide a concise summary.

Repository: ${owner}/${repo}
Workflow: ${workflowRun.name}
Branch: ${workflowRun.head_branch}
Commit: ${workflowRun.head_sha.substring(0, 7)}
Author: ${committerName}
Failed Jobs: ${failedJobs.map(j => j.name).join(', ')}

LOGS:
${logsToAnalyze}

Provide a response in this format:
1. **Root Cause**: One sentence explaining what caused the failure
2. **Error**: The specific error message (if identifiable)
3. **Suggested Fix**: Brief actionable suggestion to fix the issue
4. **Relevant Log Snippet**: The most relevant 3-5 lines from the logs (only if helpful)

Keep it concise - this will be posted to Slack. Focus on being helpful, not comprehensive.`;

    // Analyze with selected AI provider
    const summary = await analyzeWithAI(provider, apiKey, model, prompt);
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
