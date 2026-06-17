# GitHub PR Integration Guide

## Overview
This guide explains the new PR-raising functionality added to the security pipeline. Once a pipeline run completes successfully, users can click a button to automatically raise a PR to the nios repository (https://github.com/Infoblox-CTO/nios.git).

## Architecture

### Backend Changes

#### New Endpoint
- **Path**: `POST /runs/{run_id}/raise-pr`
- **Query Parameters**: 
  - `branch_name` (optional, default: "cve-fixes") - source branch name
- **Response**: 
  ```json
  {
    "success": true/false,
    "pr_number": 123,
    "pr_url": "https://github.com/Infoblox-CTO/nios/pull/123",
    "branch_name": "cve-fixes",
    "message": "PR #123 created successfully"
  }
  ```

#### New Module: `github_client.py`
- Location: `cve-analysis-platform/apps/common/github_client.py`
- Purpose: Handles GitHub API communication
- Key Class: `GitHubClient`
  - Creates PRs via GitHub REST API
  - Handles authentication with GitHub token
  - Generates PR titles and descriptions

### Frontend Changes

#### New API Call
- Location: `cve-analysis-platform/frontend/src/api.ts`
- Function: `api.raisePR(runId, branchName)`
- Returns PR creation result

#### New UI Button
- Location: `cve-analysis-platform/frontend/src/pages/RunDetail.tsx`
- Visibility: Only appears when `run.status.state === "ok"`
- Features:
  - Shows pending state while creating PR
  - Displays success with "✓ PR created" 
  - Shows "View on GitHub" link when successful
  - Displays error messages if creation fails

## Setup Instructions

### 1. GitHub Token Configuration

**Required**: Set the `GITHUB_TOKEN` environment variable with a Personal Access Token (PAT)

```bash
# Generate a new token at: https://github.com/settings/tokens/new
# Required permissions:
#   - repo (full control of private repositories)
#   - public_repo (access to public repositories)
#   - workflow (manage GitHub Actions)

export GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

**Alternative**: Add to `.env` file in the project root:
```
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 2. Verify Configuration

The endpoint will fail gracefully if `GITHUB_TOKEN` is not set:
```json
{
  "success": false,
  "error": "GITHUB_TOKEN not configured",
  "message": "GitHub token not found in environment. Set GITHUB_TOKEN to enable PR creation."
}
```

## Usage Flow

1. **Run Pipeline**: Start a pipeline analysis run as usual
2. **Wait for Completion**: Monitor the run until `state === "ok"`
3. **Click "🔗 Raise PR"**: Button appears in the RunDetail page toolbar
4. **Confirm PR Creation**: 
   - Button shows "Creating PR…" while processing
   - On success: displays "✓ PR created" with "View on GitHub" link
   - On failure: shows error message

## PR Content

When a PR is created, it includes:
- **Title**: `CVE fixes from analysis run {run_id}`
- **Description**: 
  - Analysis ID and run reference
  - Total CVEs analyzed count
  - Link to applied patches
  - Note about platform auto-remediation

- **Source Branch**: Configurable (default: `cve-fixes`)
- **Target Branch**: `develop` (hardcoded in current implementation)

## Error Handling

| Error | Cause | Resolution |
|-------|-------|-----------|
| "GITHUB_TOKEN not configured" | Env var not set | Set `GITHUB_TOKEN` environment variable |
| "PR already exists" | PR/branch already exists | Check existing PRs or use different branch name |
| "GitHub API 422" | Validation error (e.g., branch doesn't exist) | Ensure source branch is pushed to remote |
| "run not complete" | Called before run finishes | Wait for `state === "ok"` |
| "run not found" | Invalid run_id | Verify run_id exists |

## Implementation Details

### Backend Workflow
1. Validate run_id format
2. Check run completion status (must be `state === "ok"`)
3. Fetch run artifacts and metadata
4. Initialize GitHub client with token
5. Generate PR title and description from run data
6. Call GitHub API to create PR
7. Return PR URL and details or error message
8. Log event for audit trail

### Frontend Workflow
1. Show "🔗 Raise PR" button when run state is "ok"
2. On click: set pending state and call `api.raisePR()`
3. Handle response:
   - Success: show "✓ PR created" button + "View on GitHub" link
   - Error: display error message below toolbar
4. Store PR URL for linking in modal/notification

## Security Considerations

- **Token Handling**: GitHub token is read from environment only - never stored in code or frontend
- **Repository**: PR creation is limited to the nios repository (hardcoded)
- **Branch**: Default branch is `develop` - configurable via parameter
- **Authorization**: Only authenticated runs (state === "ok") can raise PRs
- **Audit**: All PR events are logged with run_id for tracking

## Future Enhancements

Possible improvements not included in this initial implementation:
- [ ] Allow configuring target branch via UI
- [ ] Auto-push commits from worktree to branch
- [ ] Draft PR option for review before submission
- [ ] Custom PR title/description templates
- [ ] PR template from repo `.github/pull_request_template.md`
- [ ] Auto-assign reviewers
- [ ] Link PR back to original run in dashboard
- [ ] Webhook notifications on PR status changes

## Testing

### Manual Testing
1. Set `GITHUB_TOKEN` environment variable
2. Start a pipeline run and wait for completion
3. On RunDetail page, verify "🔗 Raise PR" button appears
4. Click button and verify PR is created
5. Check GitHub repo for new PR

### Testing Without Token
The endpoint will return error:
```json
{
  "success": false,
  "error": "GITHUB_TOKEN not configured",
  "message": "GitHub token not found in environment..."
}
```

## Troubleshooting

### Button not appearing
- Verify run has completed: `run.status.state === "ok"`
- Check browser console for any React errors
- Ensure frontend is connected to backend

### PR creation fails
- Check `GITHUB_TOKEN` is set and valid
- Verify token has `repo` scope permissions
- Check that nios repo is accessible with token
- Look at backend logs for detailed error

### Permission denied error
- Regenerate token with proper scopes
- Verify token isn't expired
- Check token hasn't been revoked in GitHub settings
