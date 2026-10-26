$ErrorActionPreference = 'Continue'
function K($path, $body) {
  $json = $body | ConvertTo-Json -Depth 8 -Compress
  try { (Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:6806$path" -ContentType 'application/json' -Body $json -TimeoutSec 20).Content } catch { "ERR $($_.Exception.Message)" }
}
function GetId($raw) {
  $obj = $raw | ConvertFrom-Json
  if (-not $obj.data -or $obj.data.Count -eq 0) { return $null }
  return $obj.data[0].doOperations[0].id
}
$box = '20261021094009-5jo2qbm'
$docId = $null
try {
  $docId = ((K '/api/filetree/createDocWithMd' @{ notebook = $box; path = '/siyuan-dida-heading-probe'; markdown = '' }) | ConvertFrom-Json).data
  $raw = K '/api/block/appendBlock' @{ parentID = $docId; dataType = 'markdown'; data = '## 即将进行' }
  Write-Output ("h1raw len=" + $raw.Length)
  $h1 = GetId $raw
  Write-Output "h1=$h1"
  $userP = GetId (K '/api/block/appendBlock' @{ parentID = $docId; dataType = 'markdown'; data = 'user paragraph in section' })
  Write-Output "userP=$userP"
  $active = GetId (K '/api/block/appendBlock' @{ parentID = $h1; dataType = 'markdown'; data = 'active block under heading' })
  Write-Output "active=$active"
  $h2 = GetId (K '/api/block/appendBlock' @{ parentID = $docId; dataType = 'markdown'; data = '## 已完成归档' })
  Write-Output "h2=$h2"
  $archived = GetId (K '/api/block/appendBlock' @{ parentID = $h2; dataType = 'markdown'; data = 'archived block under heading' })
  Write-Output "archived=$archived"
  Start-Sleep -Seconds 2
  Write-Output '=== getChildBlocks(doc) ==='
  K '/api/block/getChildBlocks' @{ id = $docId }
  Write-Output ''
  Write-Output '=== getChildBlocks(h1) ==='
  K '/api/block/getChildBlocks' @{ id = $h1 }
  Write-Output ''
  Write-Output '=== SQL ==='
  K '/api/query/sql' @{ stmt = "SELECT id, parent_id, substr(markdown,1,36) AS md, type FROM blocks WHERE root_id = '$docId' ORDER BY id" }
} finally {
  if ($docId) { Write-Output ''; K '/api/filetree/removeDoc' @{ id = $docId; notebook = $box; path = "/$docId.sy" } }
}
