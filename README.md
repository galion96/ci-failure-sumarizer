# CI Failure Summarizer

A GitHub Action that uses AI to analyze CI/CD failures and sends human-readable summaries to Slack.

**Stop scrolling through thousands of log lines.** Get instant, actionable failure summaries delivered to your Slack channel.

## How it works

1. Your CI workflow fails
2. This action fetches the logs from failed jobs
3. Claude AI analyzes the logs and identifies the root cause
4. A summary is posted to your Slack channel with:
   - What went wrong
   - The specific error
   - Suggested fix
   - Link to the full logs

## Example Slack Message

```
CI Failed: Build and Test

Repository: your-org/your-repo
Branch: feature/new-feature
Commit: abc1234
Failed Jobs: test

---

1. **Root Cause**: TypeScript compilation failed due to a type mismatch
2. **Error**: Type 'string' is not assignable to type 'number' in src/utils.ts:42
3. **Suggested Fix**: Update the function parameter type or convert the input value

[View Workflow Run]
```

## Setup

### 1. Create a Slack Incoming Webhook

1. Go to [Slack API Apps](https://api.slack.com/apps)
2. Create a new app (or use existing)
3. Enable "Incoming Webhooks"
4. Create a webhook for your desired channel
5. Copy the webhook URL

### 2. Get an Anthropic API Key

1. Sign up at [console.anthropic.com](https://console.anthropic.com)
2. Create an API key
3. Note: This action uses Claude Sonnet by default (~$0.003-0.01 per analysis)

### 3. Add Secrets to Your Repository

Go to your repo's Settings > Secrets and variables > Actions, and add:

- `ANTHROPIC_API_KEY`: Your Anthropic API key
- `SLACK_WEBHOOK_URL`: Your Slack webhook URL

### 4. Add to Your Workflow

Create `.github/workflows/notify-failure.yml`:

```yaml
name: Notify on Failure

on:
  workflow_run:
    workflows: ["*"]  # Or specify: ["Build", "Test", "Deploy"]
    types:
      - completed

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

### Alternative: Add to Existing Workflow

You can also add it directly to your existing workflow to run on failure:

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
      - name: Analyze and notify
        uses: galion96/ci-failure-sumarizer@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          slack_webhook_url: ${{ secrets.SLACK_WEBHOOK_URL }}
```

## Configuration Options

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `github_token` | GitHub token to fetch logs | Yes | `${{ github.token }}` |
| `anthropic_api_key` | Anthropic API key | Yes | - |
| `slack_webhook_url` | Slack webhook URL | Yes | - |
| `run_id` | Workflow run ID to analyze | No | Current run |
| `max_log_lines` | Max log lines to analyze (controls cost) | No | `500` |
| `claude_model` | Claude model to use | No | `claude-sonnet-4-20250514` |
| `include_log_snippet` | Include log snippet in message | No | `true` |

## Cost Estimation

Using Claude Sonnet with default settings:
- ~$0.003-0.01 per failure analysis
- 100 failures/month ≈ $0.30-1.00

You can reduce costs by:
- Lowering `max_log_lines`
- Using `claude-haiku-3-20240307` (cheaper, still good)

## Outputs

| Output | Description |
|--------|-------------|
| `summary` | The AI-generated failure summary |
| `slack_message_ts` | Timestamp of the Slack message |

## Development

```bash
# Install dependencies
npm install

# Build the action
npm run build
```

## Contributing

Contributions are welcome! Please open an issue or PR.

## Support

If this action saved you time, consider:

<a href="https://www.buymeacoffee.com/galion96" target="_blank">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="40">
</a>

## License

MIT
