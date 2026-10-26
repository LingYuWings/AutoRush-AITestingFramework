<# .SYNOPSIS Starts the verified local Qwen vision service on loopback only. #>
[CmdletBinding()]
param(
  [ValidateSet('2B','4B','8B')][string]$ModelSize='8B',
  [string]$LlamaDirectory='',
  [string]$ModelPath='',
  [string]$ProjectorPath='',
  [ValidateRange(1024,65535)][int]$Port=8080,
  [switch]$CheckOnly
)
$ErrorActionPreference='Stop'
if(!$LlamaDirectory){$LlamaDirectory=Join-Path $PSScriptRoot '..\artifacts\tools\llama-vision-runtime'}
if(!$ModelPath){$ModelPath=Join-Path $PSScriptRoot "..\artifacts\models\Qwen3-VL-$ModelSize-Instruct-GGUF\Qwen3VL-$ModelSize-Instruct-Q4_K_M.gguf"}
if(!$ProjectorPath){$ProjectorPath=Join-Path $PSScriptRoot "..\artifacts\models\Qwen3-VL-$ModelSize-Instruct-GGUF\mmproj-Qwen3VL-$ModelSize-Instruct-F16.gguf"}
$executable=(Resolve-Path -LiteralPath (Join-Path $LlamaDirectory 'llama-server.exe')).Path
$weights=(Resolve-Path -LiteralPath $ModelPath).Path
$projector=(Resolve-Path -LiteralPath $ProjectorPath).Path
$expected=@{model='089d75c52f4b7ffc56ba998ffc50aae89fcafc755f9e7208aacca281dca6c2ae';projector='c3d5afbef5287953acd57b4043d2269456e5761a4eaccb3b71b062996970aea5'}
if($ModelSize -eq '4B'){$expected=@{model='66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a';projector='256f3a43bd4205ffef48d6b92715e1e70b5b0e9aef06522584967513a9985331'}}
if($ModelSize -eq '8B'){$expected=@{model='67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2';projector='ca524100ebf825c9a870db1c580d03879e0da0ab2541697e2458e64891cf9d38'}}
function Get-Sha256([string]$Path){
  $stream=[System.IO.File]::OpenRead($Path);$hash=[System.Security.Cryptography.SHA256]::Create()
  try{return ([System.BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}
  finally{$stream.Dispose();$hash.Dispose()}
}
if((Get-Sha256 $weights) -ne $expected.model){throw 'Model checksum mismatch'}
if((Get-Sha256 $projector) -ne $expected.projector){throw 'Projector checksum mismatch'}
$alias='autorush-vision-'+$ModelSize.ToLowerInvariant()
$arguments=@('--model',$weights,'--mmproj',$projector,'--host','127.0.0.1','--port',"$Port",'--ctx-size','8192','--parallel','1','--n-gpu-layers','all','--image-min-tokens','1024','--image-max-tokens','1024','--alias',$alias,'--jinja','--reasoning','off')
if($CheckOnly){@{host='127.0.0.1';port=$Port;alias=$alias;executable=$executable;model=$weights;projector=$projector;sha256=$expected}|ConvertTo-Json -Depth 4;exit 0}
$listener=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,$Port)
try{$listener.Start()}catch{throw "Port $Port is occupied; no existing process was changed"}finally{$listener.Stop()}
$logs=Join-Path $PSScriptRoot '..\artifacts\model-agent';New-Item -ItemType Directory -Path $logs -Force|Out-Null
$quoted=$arguments|ForEach-Object {'"'+$_.Replace('"','')+'"'}
$server=Start-Process -FilePath $executable -ArgumentList $quoted -WorkingDirectory $LlamaDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'vision.out.log') -RedirectStandardError (Join-Path $logs 'vision.err.log') -PassThru
$server.Id|Set-Content (Join-Path $logs 'vision-launcher.pid')
Write-Output "Local vision server PID $($server.Id), http://127.0.0.1:$Port/v1. See artifacts/model-agent/vision.err.log"
