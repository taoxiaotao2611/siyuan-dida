$ErrorActionPreference = 'Continue'
function K($path, $body) {
  $json = $body | ConvertTo-Json -Depth 8 -Compress
  try { (Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:6806$path" -ContentType 'application/json' -Body $json -TimeoutSec 20).Content } catch { "ERR $($_.Exception.Message)" }
}
$docId = '20261026210551-n3if58n'
$rows = (K '/api/query/sql' @{ stmt = "SELECT id, created, substr(ial,1,200) AS ial, substr(markdown,1,70) AS md FROM blocks WHERE root_id = '$docId' AND ial LIKE '%custom-dida-doc-task-id%' ORDER BY created" } | ConvertFrom-Json).data
Write-Output ("managed blocks total: " + @($rows).Count)
$byTask = @{}
foreach ($row in $rows) {
  if ($row.ial -match 'custom-dida-doc-task-id="([^"]+)"') {
    $taskId = $matches[1]
    if (-not $byTask.ContainsKey($taskId)) { $byTask[$taskId] = @() }
    $byTask[$taskId] += $row
  }
}
Write-Output ("distinct tasks: " + $byTask.Count)
$toDelete = @()
foreach ($taskId in $byTask.Keys) {
  $blocks = $byTask[$taskId]
  if ($blocks.Count -gt 1) {
    Write-Output ("task " + $taskId + " has " + $blocks.Count + " blocks, keeping " + $blocks[0].id + ", deleting " + ($blocks.Count - 1))
    for ($i = 1; $i -lt $blocks.Count; $i++) { $toDelete += $blocks[$i] }
  }
}
Write-Output ("to delete: " + $toDelete.Count)
foreach ($block in $toDelete) {
  $res = K '/api/block/deleteBlock' @{ id = $block.id }
  $ok = $false
  try { $ok = (($res | ConvertFrom-Json).code -eq 0) } catch {}
  Write-Output ("deleted " + $block.id + " ok=" + $ok)
}
Start-Sleep -Seconds 2
$remaining = (K '/api/query/sql' @{ stmt = "SELECT count(*) AS c FROM blocks WHERE root_id = '$docId' AND ial LIKE '%custom-dida-doc-task-id%'" } | ConvertFrom-Json).data
Write-Output ("remaining managed blocks: " + ($remaining | ConvertTo-Json -Compress))
$allChildren = (K '/api/block/getChildBlocks' @{ id = $docId } | ConvertFrom-Json).data
Write-Output ("doc children: " + @($allChildren).Count)
