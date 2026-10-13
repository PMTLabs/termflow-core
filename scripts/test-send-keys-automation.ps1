# ==============================================================================
# test-send-keys-automation.ps1
# Automated end-to-end verification of TermFlow MCP send_keys control character support.
# ==============================================================================

[CmdletBinding()]
param(
    [int]$ApiPort = 42051,
    [int]$McpPort = 42052,
    [switch]$SkipAgentTest,
    [switch]$KeepRunning
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$repoDir = Split-Path -Parent $scriptDir
Set-Location $repoDir

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " TermFlow send_keys Control Characters Automation Test Suite" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "API Port: $ApiPort"
Write-Host "MCP Port: $McpPort"
Write-Host ""

$devProcess = $null
$startedByScript = $false

function Test-EndpointHealthy {
    param([int]$Port, [string]$Path = "/health")
    try {
        $res = Invoke-RestMethod -Uri "http://localhost:${Port}${Path}" -TimeoutSec 3 -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

# ------------------------------------------------------------------------------
# 1. Ensure Dev Instance is Running
# ------------------------------------------------------------------------------
Write-Host "[1/4] Checking dev instance status..." -ForegroundColor Yellow

$apiOk = Test-EndpointHealthy -Port $ApiPort -Path "/health"
$mcpOk = Test-EndpointHealthy -Port $McpPort -Path "/health"

if (-not ($apiOk -and $mcpOk)) {
    Write-Host "Dev instance is not running. Launching in background..." -ForegroundColor Yellow
    $startedByScript = $true

    $env:WEBVIEW2_USER_DATA_FOLDER = "$env:LOCALAPPDATA\termflow-dev-webview"
    $env:TERMFLOW_ICON_PROFILE = "dev"

    $devProcess = Start-Process -FilePath "bun" -ArgumentList "run dev" -WorkingDirectory $repoDir -PassThru

    Write-Host "Waiting for dev endpoints to become healthy (PID: $($devProcess.Id))..." -ForegroundColor Yellow
    $maxWaitSec = 60
    $waited = 0
    while ($waited -lt $maxWaitSec) {
        Start-Sleep -Seconds 2
        $waited += 2
        $apiOk = Test-EndpointHealthy -Port $ApiPort -Path "/health"
        $mcpOk = Test-EndpointHealthy -Port $McpPort -Path "/health"
        if ($apiOk -and $mcpOk) {
            break
        }
    }

    if (-not ($apiOk -and $mcpOk)) {
        Write-Error "Dev instance failed to become healthy within $maxWaitSec seconds."
        exit 1
    }
}

Write-Host "Dev API (http://localhost:$ApiPort) and MCP (http://localhost:$McpPort) are healthy." -ForegroundColor Green
Write-Host ""

# ------------------------------------------------------------------------------
# 2. Discover or Create Active Terminal
# ------------------------------------------------------------------------------
Write-Host "[2/4] Discovering active terminal..." -ForegroundColor Yellow

$terminalsRes = Invoke-RestMethod -Uri "http://localhost:$ApiPort/api/terminals"
$terminalId = $null

if ($terminalsRes.terminals -and $terminalsRes.terminals.Count -gt 0) {
    $terminalId = $terminalsRes.terminals[0].id
    Write-Host "Found existing terminal: $terminalId" -ForegroundColor Green
} else {
    Write-Host "No existing terminal found. Creating a new one..." -ForegroundColor Yellow
    $createRes = Invoke-RestMethod -Uri "http://localhost:$ApiPort/api/terminals" -Method Post -Body (@{} | ConvertTo-Json) -ContentType "application/json"
    $terminalId = $createRes.terminalId
    if (-not $terminalId) {
        $terminalId = $createRes.id
    }
    Start-Sleep -Seconds 2
    Write-Host "Created new terminal: $terminalId" -ForegroundColor Green
}

if (-not $terminalId) {
    Write-Error "Failed to acquire an active terminal ID."
    exit 1
}

Write-Host "Target Terminal: $terminalId"
Write-Host ""

# ------------------------------------------------------------------------------
# 3. Direct MCP Protocol Automated Test Suite
# ------------------------------------------------------------------------------
Write-Host "[3/4] Running Direct MCP Protocol Tests..." -ForegroundColor Yellow

$testResults = [System.Collections.Generic.List[PSCustomObject]]::new()

function Record-TestResult([string]$Name, [bool]$Passed, [string]$Details = "") {
    $statusText = if ($Passed) { "PASS" } else { "FAIL" }
    $color = if ($Passed) { "Green" } else { "Red" }
    Write-Host "  [$statusText] $Name" -ForegroundColor $color
    if ($Details -and -not $Passed) {
        Write-Host "         Details: $Details" -ForegroundColor Red
    }
    $testResults.Add([PSCustomObject]@{
        Name = $Name
        Passed = $Passed
        Details = $Details
    })
}

# Initialize MCP Streamable HTTP session
$initHeaders = @{ "Accept" = "application/json, text/event-stream" }
$initBody = @{
    jsonrpc = "2.0"
    id = 1
    method = "initialize"
    params = @{
        protocolVersion = "2024-11-05"
        capabilities = @{}
        clientInfo = @{ name = "powershell-automation-test"; version = "1.0" }
    }
} | ConvertTo-Json -Depth 5

$initRes = Invoke-WebRequest -Uri "http://localhost:${McpPort}/mcp" -Method Post -Body $initBody -ContentType "application/json" -Headers $initHeaders
$sessionId = ($initRes.Headers["mcp-session-id"] | Select-Object -First 1)

if (-not $sessionId) {
    Write-Error "Failed to establish MCP session with http://localhost:${McpPort}/mcp"
    exit 1
}

function Invoke-McpCall([string]$Method, [hashtable]$Params) {
    $headers = @{
        "Accept" = "application/json, text/event-stream"
        "mcp-session-id" = $sessionId
    }
    $reqId = [System.Guid]::NewGuid().ToString()
    $body = @{
        jsonrpc = "2.0"
        id = $reqId
        method = $Method
        params = $Params
    } | ConvertTo-Json -Depth 6

    $res = Invoke-WebRequest -Uri "http://localhost:${McpPort}/mcp" -Method Post -Body $body -ContentType "application/json" -Headers $headers
    $line = ($res.Content -split "`n") | Where-Object { $_ -match "^data:\s*\{" } | Select-Object -First 1
    if ($line) {
        $jsonStr = $line -replace "^data:\s*", ""
        return ($jsonStr | ConvertFrom-Json)
    }
    return $null
}

function Invoke-McpTool([string]$ToolName, [hashtable]$ToolArguments) {
    return Invoke-McpCall -Method "tools/call" -Params @{
        name = $ToolName
        arguments = $ToolArguments
    }
}

function Get-TerminalScreenText([string]$TermId) {
    $resp = Invoke-McpTool -ToolName "get_terminal_screen" -ToolArguments @{ terminalId = $TermId }
    if ($resp.result -and $resp.result.content) {
        return ($resp.result.content | ForEach-Object { $_.text }) -join "`n"
    }
    return ""
}

# --- Test 1: Tool Discovery & Description Check ---
try {
    $listRes = Invoke-McpCall -Method "tools/list" -Params @{}
    $sendKeysTool = $listRes.result.tools | Where-Object { $_.name -eq "send_keys" }
    $descHasEscape = $sendKeysTool.description -match "\\u0015" -and $sendKeysTool.description -match "Ctrl\+U"
    Record-TestResult -Name "Test 1: MCP Tool Discovery & Schema Check" -Passed ($null -ne $sendKeysTool -and $descHasEscape) -Details "Tool description should document escape sequences and named keys"
} catch {
    Record-TestResult -Name "Test 1: MCP Tool Discovery & Schema Check" -Passed $false -Details $_.Exception.Message
}

# --- Test 2: Launch Node.js REPL for Readline / Composer Testing ---
try {
    # Ensure fresh prompt
    $null = Invoke-McpTool -ToolName "send_keys" -ToolArguments @{ terminalId = $terminalId; keys = "`r" }
    Start-Sleep -Milliseconds 600

    # Start Node REPL
    $null = Invoke-McpTool -ToolName "send_keys" -ToolArguments @{ terminalId = $terminalId; keys = "node`r" }
    Start-Sleep -Milliseconds 1200

    $screen = Get-TerminalScreenText -TermId $terminalId
    $inNode = $screen -match "Welcome to Node\.js" -or $screen -match ">"
    Record-TestResult -Name "Test 2: Interactive REPL Session Initialized" -Passed $inNode -Details "Expected Node.js REPL prompt '>' on screen"
} catch {
    Record-TestResult -Name "Test 2: Interactive REPL Session Initialized" -Passed $false -Details $_.Exception.Message
}

# --- Test 3: Raw Control Escape (\u0015 = Ctrl+U) Line Clear (Bug Repro) ---
try {
    $canary1 = "E2E_CANARY_TEST_101"
    $null = Invoke-McpTool -ToolName "send_keys" -ToolArguments @{ terminalId = $terminalId; keys = $canary1 }
    Start-Sleep -Milliseconds 600

    $screenBefore = Get-TerminalScreenText -TermId $terminalId
    $hasCanaryBefore = $screenBefore.Contains($canary1)

    # Send \u0015 (exact repro from bug report)
    $null = Invoke-McpTool -ToolName "send_keys" -ToolArguments @{ terminalId = $terminalId; keys = "\u0015" }
    Start-Sleep -Milliseconds 600

    $screenAfter = Get-TerminalScreenText -TermId $terminalId
    $cleared = -not $screenAfter.Contains($canary1)
    $noLiteral = -not ($screenAfter.Contains("\u0015") -or $screenAfter.Contains("u0015"))
    Record-TestResult -Name "Test 3: Raw Control Escape (\u0015) Clears Line Without Literal Text" -Passed ($hasCanaryBefore -and $cleared -and $noLiteral) -Details "Screen should contain canary before and clear without literal \u0015"
} catch {
    Record-TestResult -Name "Test 3: Raw Control Escape (\u0015) Clears Line Without Literal Text" -Passed $false -Details $_.Exception.Message
}

# --- Test 4: Named Combination (Ctrl+U) Line Clear ---
try {
    $canary2 = "E2E_NAMED_COMBO_TEST_202"
    $null = Invoke-McpTool -ToolName "send_keys" -ToolArguments @{ terminalId = $terminalId; keys = $canary2 }
    Start-Sleep -Milliseconds 600

    $null = Invoke-McpTool -ToolName "send_keys" -ToolArguments @{ terminalId = $terminalId; keys = "Ctrl+U" }
    Start-Sleep -Milliseconds 600

    $screen = Get-TerminalScreenText -TermId $terminalId
    $cleared = -not $screen.Contains($canary2)
    $noLiteral = -not $screen.Contains("Ctrl+U")
    Record-TestResult -Name "Test 4: Named Key Combination (Ctrl+U) Clears Line" -Passed ($cleared -and $noLiteral) -Details "Screen should clear '$canary2' without literal 'Ctrl+U'"
} catch {
    Record-TestResult -Name "Test 4: Named Key Combination (Ctrl+U) Clears Line" -Passed $false -Details $_.Exception.Message
}

# --- Test 5: Caret Notation (^U) Line Clear ---
try {
    $canary3 = "E2E_CARET_NOTATION_TEST_303"
    $null = Invoke-McpTool -ToolName "send_keys" -ToolArguments @{ terminalId = $terminalId; keys = $canary3 }
    Start-Sleep -Milliseconds 600

    $null = Invoke-McpTool -ToolName "send_keys" -ToolArguments @{ terminalId = $terminalId; keys = "^U" }
    Start-Sleep -Milliseconds 600

    $screen = Get-TerminalScreenText -TermId $terminalId
    $cleared = -not $screen.Contains($canary3)
    $noLiteral = -not $screen.Contains("^U")
    Record-TestResult -Name "Test 5: Caret Notation (^U) Clears Line" -Passed ($cleared -and $noLiteral) -Details "Screen should clear '$canary3' without literal '^U'"
} catch {
    Record-TestResult -Name "Test 5: Caret Notation (^U) Clears Line" -Passed $false -Details $_.Exception.Message
}

# --- Test 6: Hex Escape Sequence (\x15) Line Clear ---
try {
    $canary4 = "E2E_HEX_ESCAPE_TEST_404"
    $null = Invoke-McpTool -ToolName "send_keys" -ToolArguments @{ terminalId = $terminalId; keys = $canary4 }
    Start-Sleep -Milliseconds 600

    $null = Invoke-McpTool -ToolName "send_keys" -ToolArguments @{ terminalId = $terminalId; keys = "\x15" }
    Start-Sleep -Milliseconds 600

    $screen = Get-TerminalScreenText -TermId $terminalId
    $cleared = -not $screen.Contains($canary4)
    $noLiteral = -not ($screen.Contains("\x15") -or $screen.Contains("x15"))
    Record-TestResult -Name "Test 6: Hex Escape Sequence (\x15) Clears Line" -Passed ($cleared -and $noLiteral) -Details "Screen should clear '$canary4' without literal '\x15'"

    # Exit Node REPL back to PowerShell
    $null = Invoke-McpTool -ToolName "send_keys" -ToolArguments @{ terminalId = $terminalId; keys = ".exit`r" }
    Start-Sleep -Milliseconds 800
} catch {
    Record-TestResult -Name "Test 6: Hex Escape Sequence (\x15) Clears Line" -Passed $false -Details $_.Exception.Message
}

# --- Test 7: Empty Keys Error Handling ---
try {
    $emptyRes = Invoke-McpTool -ToolName "send_keys" -ToolArguments @{ terminalId = $terminalId; keys = "" }
    $isError = ($emptyRes.result.isError -eq $true)
    $hasHint = ($emptyRes.result.content[0].text -match "empty" -and $emptyRes.result.content[0].text -match "\\u0015")
    Record-TestResult -Name "Test 7: Empty Keys Throws Actionable Error" -Passed ($isError -and $hasHint) -Details "Empty keys must return isError=true with actionable escape instructions"
} catch {
    Record-TestResult -Name "Test 7: Empty Keys Throws Actionable Error" -Passed $false -Details $_.Exception.Message
}

Write-Host ""

# ------------------------------------------------------------------------------
# 4. Agent End-to-End Test (Claude Code with Haiku)
# ------------------------------------------------------------------------------
if (-not $SkipAgentTest) {
    Write-Host "[4/4] Running Claude Code Agent End-to-End Test (haiku)..." -ForegroundColor Yellow

    $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
    if (-not $claudeCmd) {
        Write-Host "Claude CLI not found in PATH; skipping agent test." -ForegroundColor DarkGray
    } else {
        $tempMcpConfigFile = Join-Path $repoDir "test-mcp-haiku-automation.json"
        try {
            @{
                mcpServers = @{
                    termflow = @{
                        type = "http"
                        url = "http://localhost:${McpPort}/mcp"
                    }
                }
            } | ConvertTo-Json -Depth 4 | Set-Content -Path $tempMcpConfigFile -Encoding utf8

            $prompt = @"
In terminal ${terminalId}:
1. Call mcp__termflow__send_keys with keys='node\r'.
2. Call mcp__termflow__get_terminal_screen to verify the Node.js prompt '>' appears.
3. Call mcp__termflow__send_keys with keys='pending_composer_text'.
4. Call mcp__termflow__get_terminal_screen to verify 'pending_composer_text' is on screen.
5. Call mcp__termflow__send_keys with keys='\u0015' to clear the line using Ctrl+U.
6. Call mcp__termflow__get_terminal_screen to verify 'pending_composer_text' is gone, the prompt is clean '>', and NO literal '\u0015' was printed.
7. Call mcp__termflow__send_keys with keys='.exit\r' to quit Node.js.
8. If the line was cleared without literal text, print VERIFICATION_SUCCESS. Otherwise print VERIFICATION_FAILED.
"@

            Write-Host "Invoking Claude Code with haiku model..." -ForegroundColor Yellow
            $agentOutput = $null | claude --mcp-config $tempMcpConfigFile --dangerously-skip-permissions --model haiku -p $prompt 2>&1
            $agentText = ($agentOutput -join "`n")

            $agentPassed = $agentText.Contains("VERIFICATION_SUCCESS")
            Record-TestResult -Name "Test 8: Claude Code Haiku Agent MCP Integration" -Passed $agentPassed -Details "Agent should invoke send_keys and verify line clear"

            if (-not $agentPassed) {
                Write-Host "Agent Output Snippet:" -ForegroundColor DarkGray
                Write-Host ($agentText.Substring(0, [Math]::Min(500, $agentText.Length))) -ForegroundColor DarkGray
            }
        } catch {
            Record-TestResult -Name "Test 8: Claude Code Haiku Agent MCP Integration" -Passed $false -Details $_.Exception.Message
        } finally {
            if (Test-Path $tempMcpConfigFile) {
                Remove-Item $tempMcpConfigFile -Force -ErrorAction SilentlyContinue
            }
        }
    }
} else {
    Write-Host "[4/4] Skipping Claude Code Agent Test (-SkipAgentTest specified)." -ForegroundColor DarkGray
}

Write-Host ""

# ------------------------------------------------------------------------------
# 5. Cleanup & Summary Report
# ------------------------------------------------------------------------------
if ($startedByScript -and -not $KeepRunning) {
    Write-Host "Stopping dev instance started by this test suite..." -ForegroundColor Yellow
    if ($devProcess -and -not $devProcess.HasExited) {
        Stop-Process -Id $devProcess.Id -Force -ErrorAction SilentlyContinue
    }
    Stop-Process -Name "termflow-app" -Force -ErrorAction SilentlyContinue
}

$allPassed = ($testResults | Where-Object { -not $_.Passed }).Count -eq 0
$totalCount = $testResults.Count
$passedCount = ($testResults | Where-Object { $_.Passed }).Count
$failedCount = $totalCount - $passedCount

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "                    AUTOMATION SUMMARY" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Total Tests : $totalCount"
Write-Host "Passed      : $passedCount" -ForegroundColor Green
Write-Host "Failed      : $failedCount" -ForegroundColor $(if ($failedCount -eq 0) { "Green" } else { "Red" })
Write-Host "============================================================" -ForegroundColor Cyan

if ($allPassed) {
    Write-Host "ALL TESTS PASSED!" -ForegroundColor Green
    exit 0
} else {
    Write-Host "SOME TESTS FAILED!" -ForegroundColor Red
    exit 1
}
