# CI Failure Summarizer

A GitHub Action that uses AI to analyze CI/CD failures and sends human-readable summaries to Slack.

**Stop scrolling through thousands of log lines.** Get instant, actionable failure summaries delivered to Slack — either to a channel or directly to the person who broke the build.

## How it works

1. Your CI workflow fails
2. This action fetches the logs from failed jobs
3. AI analyzes the logs and identifies the root cause
4. A summary is sent to Slack with:
   - What went wrong
   - The specific error
   - Suggested fix
   - Link to the full logs

## AI Providers

Choose the AI provider that fits your needs:

| Provider | Model | Cost | Notes |
|----------|-------|------|-------|
| `anthropic` | Claude Sonnet | ~$0.003-0.01/analysis | Best quality (default) |
| `groq` | Llama 3.3 70B | **FREE** | Fast inference, generous free tier |
| `gemini` | Gemini 2.0 Flash | **FREE** | 15 req/min free tier |

## Notification Modes

| Mode | Description |
|------|-------------|
| `channel` | Posts to a Slack channel via webhook (default) |
| `dm` | DMs the person who made the commit that broke the build |

## Examples

### Channel Notification
![Channel Failure](screenshots/channel-failure.png)

### DM Notification
![DM Failure](screenshots/dm-failure.png)

## Setup

### Option A: Channel Notifications (Webhook)

#### 1. Create a Slack Incoming Webhook

1. Go to [Slack API Apps](https://api.slack.com/apps)
2. Create a new app (or use existing)
3. Enable "Incoming Webhooks"
4. Create a webhook for your desired channel
5. Copy the webhook URL

#### 2. Add to Your Workflow

```yaml
- uses: galion96/ci-failure-sumarizer@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    slack_webhook_url: ${{ secrets.SLACK_WEBHOOK_URL }}
```

#### Using Free Providers (Groq or Gemini)

```yaml
# Option: Use Groq (FREE)
- uses: galion96/ci-failure-sumarizer@v1
  with:
    provider: groq
    groq_api_key: ${{ secrets.GROQ_API_KEY }}
    slack_webhook_url: ${{ secrets.SLACK_WEBHOOK_URL }}

# Option: Use Gemini (FREE)
- uses: galion96/ci-failure-sumarizer@v1
  with:
    provider: gemini
    gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
    slack_webhook_url: ${{ secrets.SLACK_WEBHOOK_URL }}
```

---

### Option B: DM the Committer (Bot Token)

This mode looks up the committer's email in Slack and DMs them directly.

#### 1. Create a Slack App with Bot Token

1. Go to [Slack API Apps](https://api.slack.com/apps)
2. Create a new app → "From scratch"
3. Go to **OAuth & Permissions**
4. Add these **Bot Token Scopes**:
   - `users:read.email` — Look up users by email
   - `users:read` — Read user info
   - `chat:write` — Send messages
   - `im:write` — Open DM channels
5. Click **Install to Workspace**
6. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

#### 2. Add to Your Workflow

```yaml
- uses: galion96/ci-failure-sumarizer@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    slack_bot_token: ${{ secrets.SLACK_BOT_TOKEN }}
    notification_mode: dm
    fallback_channel: C1234567890  # Optional: channel ID if user lookup fails
```

**Important:** The committer's GitHub email must match their Slack email for DM lookup to work.

---

### Get an API Key

#### Anthropic (Paid)
1. Sign up at [console.anthropic.com](https://console.anthropic.com)
2. Create an API key
3. Cost: ~$0.003-0.01 per analysis

#### Groq (FREE)
1. Sign up at [console.groq.com](https://console.groq.com)
2. Create an API key
3. Free tier with generous rate limits

#### Google Gemini (FREE)
1. Go to [aistudio.google.com](https://aistudio.google.com)
2. Get an API key
3. Free tier: 15 requests per minute

### Add Secrets to Your Repository

Go to your repo's Settings > Secrets and variables > Actions, and add the relevant secrets:

- `ANTHROPIC_API_KEY`: Your Anthropic API key (if using Anthropic)
- `GROQ_API_KEY`: Your Groq API key (if using Groq)
- `GEMINI_API_KEY`: Your Gemini API key (if using Gemini)
- `SLACK_WEBHOOK_URL`: Your Slack webhook URL (for channel mode)
- `SLACK_BOT_TOKEN`: Your Slack bot token (for DM mode)

## Full Workflow Examples

### Channel Mode (Webhook)

```yaml
name: Notify on Failure

on:
  workflow_run:
    workflows: ["*"]
    types: [completed]

jobs:
  notify:
    runs-on: ubuntu-latest
    if: ${{ github.event.workflow_run.conclusion == 'failure' }}
    steps:
      - name: Analyze and notify
        uses: galion96/ci-failure-sumarizer@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          slack_webhook_url: ${{ secrets.SLACK_WEBHOOK_URL }}
          run_id: ${{ github.event.workflow_run.id }}
```

### DM Mode (Bot Token)

```yaml
name: Build and Test

on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install
      - run: npm test

  notify-on-failure:
    runs-on: ubuntu-latest
    needs: [build]
    if: failure()
    steps:
      - name: DM the committer
        uses: galion96/ci-failure-sumarizer@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          slack_bot_token: ${{ secrets.SLACK_BOT_TOKEN }}
          notification_mode: dm
          fallback_channel: C1234567890  # Posts here if user lookup fails
```

## Configuration Options

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `github_token` | GitHub token to fetch logs | Yes | `${{ github.token }}` |
| `provider` | AI provider: `anthropic`, `groq`, or `gemini` | No | `anthropic` |
| `anthropic_api_key` | Anthropic API key | If provider=anthropic | - |
| `groq_api_key` | Groq API key (FREE) | If provider=groq | - |
| `gemini_api_key` | Google Gemini API key (FREE) | If provider=gemini | - |
| `model` | Model to use | No | Provider default* |
| `slack_webhook_url` | Slack webhook URL (channel mode) | No** | - |
| `slack_bot_token` | Slack bot token (DM mode) | No** | - |
| `notification_mode` | `channel` or `dm` | No | `channel` |
| `fallback_channel` | Channel ID if DM lookup fails | No | - |
| `run_id` | Workflow run ID to analyze | No | Current run |
| `max_log_lines` | Max log lines to analyze | No | `500` |

*Default models: anthropic=`claude-sonnet-4-20250514`, groq=`llama-3.3-70b-versatile`, gemini=`gemini-2.0-flash`

**Either `slack_webhook_url` or `slack_bot_token` is required depending on mode.

## Outputs

| Output | Description |
|--------|-------------|
| `summary` | The AI-generated failure summary |
| `slack_message_ts` | Timestamp of the Slack message |
| `notified_user` | Slack user ID that was DMed (DM mode only) |

## Cost Estimation

| Provider | Cost per Analysis | 100 failures/month |
|----------|-------------------|-------------------|
| Groq | **FREE** | $0 |
| Gemini | **FREE** | $0 |
| Anthropic | ~$0.003-0.01 | ~$0.30-1.00 |

For Anthropic, you can reduce costs by:
- Lowering `max_log_lines`
- Using a smaller model like `claude-haiku-3-20240307`

## Development

```bash
# Install dependencies
npm install

# Build the action
npm run build
```

## Contributing

Contributions are welcome! Please open an issue or PR.

## License

MIT
