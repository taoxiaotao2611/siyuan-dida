$ErrorActionPreference = 'Continue'
function K($path, $body) {
  $json = $body | ConvertTo-Json -Depth 8 -Compress
  try { (Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:6806$path" -ContentType 'application/json' -Body $json -TimeoutSec 20).Content } catch { "ERR $($_.Exception.Message)" }
}
function GetId($raw) { $o = $raw | ConvertFrom-Json; if (-not $o.data -or $o.data.Count -eq 0) { return $null }; return $o.data[0].doOperations[0].id }
$box = '20261021094009-5jo2qbm'
$docId = $null
try {
  $docId = ((K '/api/filetree/createDocWithMd' @{ notebook = $box; path = '/siyuan-dida-insert-probe'; markdown = '' }) | ConvertFrom-Json).data
  $h1 = GetId (K '/api/block/appendBlock' @{ parentID = $docId; dataType = 'markdown'; data = '## 即将进行' })
  $h2 = GetId (K '/api/block/appendBlock' @{ parentID = $docId; dataType = 'markdown'; data = '## 已完成归档' })
  Write-Output "h1=$h1 h2=$h2"
  Write-Output '--- insert after h1 (first child) ---'
  $a1 = GetId (K '/api/block/insertBlock' @{ previousID = $h1; dataType = 'markdown'; data = 'active-1' })
  Write-Output "a1=$a1"
  Write-Output '--- insert after a1 (second child) ---'
  $a2 = GetId (K '/api/block/insertBlock' @{ previousID = $a1; dataType = 'markdown'; data = 'active-2' })
  Write-Output "a2=$a2"
  Write-Output '--- insert after h2 (archived child) ---'
  $z1 = GetId (K '/api/block/insertBlock' @{ previousID = $h2; dataType = 'markdown'; data = 'archived-1' })
  Write-Output "z1=$z1"
  Start-Sleep -Seconds 2
  Write-Output '=== getChildBlocks(doc) ==='
  K '/api/block/getChildBlocks' @{ id = $docId }
  Write-Output ''
  Write-Output '=== getChildBlocks(h1) ==='
  K '/api/block/getChildBlocks' @{ id = $h1 }
  Write-Output ''
  Write-Output '=== SQL ==='
  K '/api/query/sql' @{ stmt = "SELECT id, parent_id, substr(markdown,1,30) AS md, type FROM blocks WHERE root_id = '$docId' ORDER BY id" }
} finally {
  if ($docId) { Write-Output ''; K '/api/filetree/removeDoc' @{ id = $docId; notebook = $box; path = "/$docId.sy" } }
}
