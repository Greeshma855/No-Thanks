# Execution Steps

This guide covers installation, provider configuration, execution modes, recordings, and verification commands for **No Thanks**.

## Quick Start (30-Second Zero-Config Trial)

Run a deterministic offline audit with the local fixture server and mock provider. No API key, AWS account, or remote model setup is required.

```bash
# Install dependencies and Playwright Chromium
npm install && npx playwright install chromium

# Start fixtures and run an instant offline audit
npm run fixtures &
npm run no-thanks -- --url http://127.0.0.1:4173/nested-settings --mode inspector --provider mock
```

## 1. Prerequisites

- Node.js 20 or newer
- Chromium installed through Playwright
- An OpenAI API key or AWS credentials only when using the corresponding remote provider

```bash
npm install
npx playwright install chromium
```

Copy `.env.example` to `.env`, then configure only the provider you intend to use. Never commit API keys or include them in screenshots, reports, or shared shell history.

## 2. Choose a reasoning provider

`MODEL_PROVIDER` selects exactly one provider. The application never silently falls back between paid providers.

### Deterministic mock provider

The mock provider is free, offline, and used by the automated test suite.

```powershell
$env:MODEL_PROVIDER="mock"
```

### OpenAI through Strands

```powershell
$env:MODEL_PROVIDER="openai"
$env:OPENAI_API_KEY="your-key"
$env:OPENAI_MODEL="gpt-5.6-terra"
$env:REMOTE_ANALYSIS_ALLOWED_HOSTS="example.com,*.example.org"
```

The OpenAI provider uses the Strands OpenAI Responses model. Remote analysis is denied unless the current hostname matches `REMOTE_ANALYSIS_ALLOWED_HOSTS`. Use `*` only when you knowingly permit analysis for every HTTP(S) host.

### Amazon Bedrock through Strands

```powershell
$env:MODEL_PROVIDER="bedrock"
$env:AWS_REGION="us-east-1"
$env:BEDROCK_MODEL_ID="us.anthropic.claude-3-5-sonnet-20241022-v2:0" # or "us.amazon.nova-pro-v1:0"
$env:REMOTE_ANALYSIS_ALLOWED_HOSTS="example.com"
```

Bedrock is initialized only when selected. Your AWS identity must have access to the configured multimodal model or inference profile, and availability varies by region.

## 3. Single-URL audits

Use Inspector mode for a visible browser with the reasoning overlay:

```bash
npm run no-thanks -- --url https://example.com --mode inspector --provider mock
```

Use Guardian mode for headless production-style execution:

```bash
npm run no-thanks -- --url https://example.com --mode guardian --provider mock
```

`npm run guardian` remains an equivalent compatibility alias. Add `--display-profile laptop`, `recording`, or `custom` when a particular capture size is required.

## 4. Persistent interactive browser

```bash
npm run browser
```

This opens a visible Chromium session with an address bar and normal tabs. Each stable top-level navigation starts an isolated audit run. Tabs share the persistent browser profile but keep separate audit queues and evidence.

Close the browser normally or press `Ctrl+C` so recordings finalize correctly.

## 5. Local deterministic fixtures

Start the fixture server:

```bash
npm run fixtures
```

Then audit a fixture from another terminal:

```bash
npm run no-thanks -- --url http://127.0.0.1:4173/nested-settings --mode inspector --provider mock
```

Fixtures cover visible rejection, nested settings, preselected toggles, late banners, iframes, sticky action bars, scrollable preferences, stale consent targets, and ambiguous interfaces.

## 6. Recordings and artifacts

Interactive browser sessions always record each tab. Single-URL runs can opt into video and trace capture:

```powershell
$env:GUARDIAN_RECORD_VIDEO="true"
$env:GUARDIAN_RECORD_TRACE="true"
npm run no-thanks -- --url https://example.com --mode inspector --provider mock
```

Single-URL evidence is written under `artifacts/run-<timestamp>/`. Interactive evidence is written under `artifacts/browser-session-<timestamp>/`. Outputs can include:

- `report.html`
- `audit.json`
- DOM screenshots
- WebM recordings
- Playwright traces
- Browser-session manifests

Playwright finalizes WebM files only after the page or browser context closes.

## 7. Important configuration

| Variable                        | Purpose                                        | Default                       |
| ------------------------------- | ---------------------------------------------- | ----------------------------- |
| `MODEL_PROVIDER`                | Selects `mock`, `openai`, or `bedrock`         | `mock`                        |
| `OPENAI_MODEL`                  | OpenAI image-capable Responses model           | `gpt-5.6-terra`               |
| `AWS_REGION`                    | Bedrock region                                 | Required for Bedrock          |
| `BEDROCK_MODEL_ID`              | Bedrock multimodal model identifier            | Required for Bedrock          |
| `REMOTE_ANALYSIS_ALLOWED_HOSTS` | Hosts allowed to send masked evidence remotely | Empty; remote analysis denied |
| `MAX_MODEL_CALLS_PER_AUDIT`     | Paid model-call limit per navigation           | `3`                           |
| `MAX_CONCURRENT_AUDITS`         | Cross-tab audit concurrency                    | `1`                           |
| `SCREENSHOT_MAX_WIDTH`          | Maximum remote screenshot width                | `1280`                        |
| `SCREENSHOT_JPEG_QUALITY`       | Remote JPEG quality                            | `75`                          |
| `GUARDIAN_MAX_STEPS`            | Maximum useful reasoning steps                 | `8`                           |
| `GUARDIAN_MIN_CONFIDENCE`       | Minimum confidence for an action               | `0.75`                        |
| `GUARDIAN_ARTIFACT_DIR`         | Generated evidence root                        | `artifacts`                   |
| `GUARDIAN_RECORD_VIDEO`         | Records a single-URL run                       | `false`                       |
| `GUARDIAN_RECORD_TRACE`         | Records a Playwright trace                     | `false`                       |
| `BROWSER_SLOW_MO_MS`            | Interactive browser pacing                     | `250`                         |

The legacy `GUARDIAN_PROVIDER` variable remains a compatibility alias, but `MODEL_PROVIDER` takes precedence.

## 8. Verification commands

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

Normal automated tests use local fixtures and do not spend model credits. Run the opt-in Bedrock connectivity check only when your AWS account is configured:

```bash
npm run bedrock:smoke -- --url https://example.com
```

## Troubleshooting

- **Missing provider credentials:** configure only the selected provider's credentials.
- **Remote audit is skipped:** add the exact hostname to `REMOTE_ANALYSIS_ALLOWED_HOSTS`.
- **Chromium is missing:** run `npx playwright install chromium`.
- **A recording is unfinished:** close the tab or browser normally; a forcibly terminated Playwright video may be unrecoverable.
- **PowerShell blocks `npm.ps1`:** run the equivalent command with `npm.cmd`.
- **Fixture port is busy:** reuse or stop the process already listening on port 4173.
- **No display is available:** use single-URL Guardian mode.
