# Teste da fila numerada: trabalhos falsos curtos (sleep) numa pasta de dados isolada.
# Uso: pwsh -NoProfile -File fila/teste-fila.ps1   (sai com 0 se tudo passou)
$ErrorActionPreference = 'Stop'
$fila = Join-Path $PSScriptRoot 'fila-build.ps1'
$raiz = Join-Path ([IO.Path]::GetTempPath()) "fila-ensaio-$PID"   # sem 'test' no caminho: o tipo é deduzido do texto
$env:FILA_BUILD_DIR = Join-Path $raiz 'dados'
New-Item -ItemType Directory -Force $env:FILA_BUILD_DIR | Out-Null
$trab = Join-Path $raiz 'trabalho.ps1'
@'
param([double]$Segundos, [int]$Codigo, [string]$Marca)
"trabalho $Marca começou"
Start-Sleep -Milliseconds ([int]($Segundos * 1000))
"trabalho $Marca acabou"
exit $Codigo
'@ | Set-Content -LiteralPath $trab
$fichas = Join-Path $env:FILA_BUILD_DIR 'fichas'
$falhas = [Collections.Generic.List[string]]::new()
$maxVagas = 0
$jobs = @{}

function Ok($cond, [string]$msg) {
    if ([bool]$cond) { Write-Host "  ok   $msg" } else { Write-Host "  FALHA $msg" -ForegroundColor Red; $falhas.Add($msg) }
}

function Iniciar([string]$nome, [double]$seg = 1, [int]$cod = 0, [switch]$Sozinho, [string]$Tipo, [string[]]$extra = @()) {
    $a = @('-NoProfile', '-File', $fila, '-Nome', $nome)
    if ($Sozinho) { $a += '-Sozinho' }
    if ($Tipo) { $a += @('-Tipo', $Tipo) }
    $a += @('pwsh', '-NoProfile', '-File', $trab, "$seg", "$cod", $nome) + $extra
    $out = Join-Path $raiz "$nome.out"
    $p = Start-Process pwsh -ArgumentList $a -RedirectStandardOutput $out -NoNewWindow -PassThru
    $null = $p.Handle   # sem isso o ExitCode some depois que o processo termina
    $jobs[$nome] = [pscustomobject]@{ nome = $nome; proc = $p; out = $out }
    Start-Sleep -Milliseconds 300   # chegada em ordem
}

function Ler([string]$p) {
    # A ficha é trocada por rename: uma leitura pode bater no instante da troca; tenta de novo.
    for ($k = 0; $k -lt 5; $k++) { try { return Get-Content -Raw -LiteralPath $p -ErrorAction Stop | ConvertFrom-Json } catch { Start-Sleep -Milliseconds 30 } }
}
function Fichas { @(Get-ChildItem $fichas -Filter *.json -ErrorAction SilentlyContinue | ForEach-Object { Ler $_.FullName } | Where-Object { $_ }) }
function Ficha([string]$nome) { Fichas | Where-Object nome -eq $nome | Select-Object -First 1 }
function Amostra {
    $usadas = (Fichas | Where-Object estado -eq 'rodando' | Measure-Object -Property vagas -Sum).Sum
    if ($usadas -gt $script:maxVagas) { $script:maxVagas = $usadas }
}
function Esperar([scriptblock]$cond, [double]$seg = 20) {
    $t = (Get-Date).AddSeconds($seg)
    while ((Get-Date) -lt $t) { Amostra; if (& $cond) { return $true }; Start-Sleep -Milliseconds 100 }
    $false
}
function EsperarFim([string[]]$nomes, [double]$seg = 40) {
    $ok = Esperar { @($nomes | Where-Object { -not $jobs[$_].proc.HasExited }).Count -eq 0 } $seg
    Ok $ok "terminaram: $($nomes -join ', ')"
}
function Hist([string]$nome) {
    $h = Join-Path $env:FILA_BUILD_DIR 'historico.jsonl'
    if (-not (Test-Path $h)) { return $null }
    Get-Content $h | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object nome -eq $nome | Select-Object -Last 1
}
function T($s) { if ($s -is [DateTime]) { $s } else { [DateTime]::Parse("$s", $null, 'RoundtripKind') } }
function Ctl { & pwsh -NoProfile -File $fila @args | Out-Null; $LASTEXITCODE }

try {
    Write-Host '1. duas vagas, ordem de chegada, código de saída e log'
    Iniciar A 3; Iniciar B 3; Iniciar C 1 7
    Ok (Esperar { (Ficha A).estado -eq 'rodando' -and (Ficha B).estado -eq 'rodando' }) 'A e B rodando'
    Ok (Esperar { $null -ne (Ficha C) }) 'C entrou na fila'
    Start-Sleep -Milliseconds 800
    Ok ((Ficha C).estado -eq 'espera') 'C espera com as duas vagas ocupadas'
    EsperarFim A, B, C
    Ok ((T (Hist C).comeco) -ge (T (Hist A).fim).AddSeconds(-0.5)) 'C só começou quando uma vaga soltou'
    Ok ($jobs.C.proc.ExitCode -eq 7) "código 7 repassado (veio $($jobs.C.proc.ExitCode))"
    Ok ((Hist C).codigo -eq 7) 'histórico guarda o código'
    Ok ((Get-Content -Raw (Hist C).log) -match 'trabalho C acabou') 'log da ficha tem a saída'
    Ok ((Get-Content -Raw (Hist C).log) -match 'trabalho C começou') 'acento legível no log'
    Ok ((Get-Content -Raw $jobs.C.out) -match 'trabalho C acabou') 'quem chamou viu a saída'
    Ok ($jobs.A.proc.ExitCode -eq 0) 'A saiu com 0'

    Write-Host '2. pausa e reordenação (topo, baixo, cima)'
    Ok ((Ctl -Pausar) -eq 0) 'pausar'
    Iniciar D 1; Iniciar E 1; Iniciar F 3; Iniciar G 1
    Start-Sleep -Milliseconds 1500
    Ok (@(Fichas | Where-Object estado -eq 'rodando').Count -eq 0) 'pausada: nada começa'
    Ok (Esperar { "$(Get-Content -Raw $jobs.G.out)" -match 'PAUSADA' } 10) 'aviso de pausa para quem chamou'
    Ok ((Ctl -Mover (Ficha G).id topo) -eq 0) 'G para o topo'    # G D E F
    Ok ((Ctl -Mover (Ficha E).id baixo) -eq 0) 'E para baixo'    # G D F E
    Ok ((Ctl -Mover (Ficha F).id cima) -eq 0) 'F para cima'      # G F D E
    Ok ((Ctl -Mover 'nao-existe' topo) -ne 0) 'mover id inexistente falha'
    Ok ((Ctl -Soltar) -eq 0) 'soltar'
    EsperarFim D, E, F, G
    $g = T (Hist G).comeco; $f = T (Hist F).comeco; $d = T (Hist D).comeco; $e = T (Hist E).comeco
    Ok ($g -lt $d -and $f -lt $d) 'G e F (topo e cima) começaram antes de D'
    Ok ($d -lt $e) 'D antes de E (E foi para baixo)'
    $vaga = @((T (Hist D).fim), (T (Hist F).fim)) | Sort-Object | Select-Object -First 1
    Ok ($e -ge $vaga.AddSeconds(-0.5)) 'E esperou vaga (de D ou F)'

    Write-Host '3. cancelar em espera'
    Ctl -Pausar | Out-Null
    Iniciar H 1
    Ok (Esperar { (Ficha H).estado -eq 'espera' }) 'H na fila'
    Ok ((Ctl -Cancelar (Ficha H).id) -eq 0) 'cancelar H'
    EsperarFim H 10
    Ok ($jobs.H.proc.ExitCode -ne 0) "H saiu com código não zero ($($jobs.H.proc.ExitCode))"
    Ok ((Get-Content -Raw $jobs.H.out) -match 'cancelado no painel antes de') 'mensagem clara de cancelamento'
    Ok ($null -eq (Hist H)) 'H não entrou no histórico (não rodou)'
    Ok ($null -eq (Ficha H)) 'ficha de H sumiu'
    Ctl -Soltar | Out-Null

    Write-Host '4. matar rodando'
    Iniciar I 30
    Ok (Esperar { (Ficha I).estado -eq 'rodando' }) 'I rodando'
    Start-Sleep -Milliseconds 500
    $t0 = Get-Date
    Ok ((Ctl -Cancelar (Ficha I).id) -eq 0) 'matar I'
    EsperarFim I 15
    Ok (((Get-Date) - $t0).TotalSeconds -lt 10) 'I morreu logo (não esperou os 30 s)'
    Ok ($jobs.I.proc.ExitCode -ne 0) "I saiu com código não zero ($($jobs.I.proc.ExitCode))"
    Ok ((Hist I).cancelado -eq $true) 'histórico marca cancelado'
    Ok ((Get-Content -Raw $jobs.I.out) -match 'morto pelo painel') 'mensagem de morto'

    Write-Host '5. -Sozinho ocupa as duas vagas'
    Iniciar J 3
    Ok (Esperar { (Ficha J).estado -eq 'rodando' }) 'J rodando'
    Iniciar S 1 -Sozinho; Iniciar N 1
    Start-Sleep -Milliseconds 1000
    Ok ((Ficha S).estado -eq 'espera' -and (Ficha N).estado -eq 'espera') 'S e N esperam (N atrás de S, mesmo com vaga livre)'
    Ok (@((Ficha S).seguras | Where-Object { $_ -ne 'sozinho' }).Count -eq 1) 'S segura a vaga livre'
    EsperarFim J, S, N
    Ok ((T (Hist S).comeco) -ge (T (Hist J).fim).AddSeconds(-0.5)) 'S esperou J acabar'
    Ok ((T (Hist N).comeco) -ge (T (Hist S).fim).AddSeconds(-0.5)) 'N esperou S acabar'
    Ok ((Hist S).tipo -eq 'Medição') '-Sozinho vira Medição'

    Write-Host '6. vagas da versão antiga (lock/lock2)'
    foreach ($v in 'lock', 'lock2') {
        New-Item -ItemType Directory -Force (Join-Path $env:FILA_BUILD_DIR $v) | Out-Null
        "$PID|velha|$(Get-Date -Format o)" | Set-Content (Join-Path $env:FILA_BUILD_DIR "$v\dono.txt")
    }
    Iniciar L 1
    Start-Sleep -Milliseconds 1500
    Ok ((Ficha L).estado -eq 'espera') 'L respeita as vagas da versão antiga'
    Remove-Item -Recurse -Force (Join-Path $env:FILA_BUILD_DIR 'lock2')
    EsperarFim L
    $morto = Start-Process pwsh -ArgumentList '-NoProfile', '-c', 'exit' -PassThru -NoNewWindow; $morto.WaitForExit()
    New-Item -ItemType Directory -Force (Join-Path $env:FILA_BUILD_DIR 'lock2') | Out-Null
    "$PID|velha|$(Get-Date -Format o)" | Set-Content (Join-Path $env:FILA_BUILD_DIR 'lock2\dono.txt')
    "$($morto.Id)|velha-morta|$(Get-Date -Format o)" | Set-Content (Join-Path $env:FILA_BUILD_DIR 'lock\dono.txt')
    Iniciar M 0.5
    EsperarFim M 10
    Ok ($null -ne (Hist M)) 'vaga antiga de dono morto é quebrada'
    Remove-Item -Recurse -Force (Join-Path $env:FILA_BUILD_DIR 'lock2')

    Write-Host '7. ficha de dono morto não trava a fila'
    @{ id = '00000000-000000-000-1'; pid = $morto.Id; inicioProc = 1; nome = 'fantasma'; estado = 'espera'; vagas = 2; seguras = @() } |
        ConvertTo-Json | Set-Content (Join-Path $fichas '00000000-000000-000-1.json')
    Iniciar O 0.5
    EsperarFim O 10
    Ok ($null -ne (Hist O)) 'O rodou apesar do fantasma no topo'
    Ok (-not (Test-Path (Join-Path $fichas '00000000-000000-000-1.json'))) 'ficha do fantasma foi limpa'

    Write-Host '8. tipo deduzido do comando e muitos de uma vez'
    Iniciar P1 0.2 -extra 'cargo'; Iniciar P2 0.2 -extra 'pytest'; Iniciar P3 0.2 -extra '--hidden-window'
    Iniciar P4 0.2 -Tipo 'Custom'; Iniciar P5 0.2
    $muitos = 1..6 | ForEach-Object { "Q$_" }
    foreach ($q in $muitos) {
        $out = Join-Path $raiz "$q.out"
        $p = Start-Process pwsh -ArgumentList '-NoProfile', '-File', $fila, '-Nome', $q, 'pwsh', '-NoProfile', '-File', $trab, '0.5', '0', $q -RedirectStandardOutput $out -NoNewWindow -PassThru
        $null = $p.Handle; $jobs[$q] = [pscustomobject]@{ nome = $q; proc = $p; out = $out }
    }
    EsperarFim (@('P1', 'P2', 'P3', 'P4', 'P5') + $muitos) 60
    Ok ((Hist P1).tipo -eq 'Build') "cargo -> Build ($((Hist P1).tipo))"
    Ok ((Hist P2).tipo -eq 'Teste') "pytest -> Teste ($((Hist P2).tipo))"
    Ok ((Hist P3).tipo -eq 'Jogo') "--hidden-window -> Jogo ($((Hist P3).tipo))"
    Ok ((Hist P4).tipo -eq 'Custom') "-Tipo respeitado ($((Hist P4).tipo))"
    Ok ((Hist P5).tipo -eq 'Outro') "sem pista -> Outro ($((Hist P5).tipo))"
    Ok (@($muitos | Where-Object { Hist $_ }).Count -eq 6) 'os seis simultâneos rodaram e foram para o histórico'
    Ok (@(Get-ChildItem $fichas).Count -eq 0) 'nenhuma ficha sobrou'

    Write-Host '10. dois -Sozinho com o segundo no topo não travam'
    Iniciar J2 2
    Ok (Esperar { (Ficha J2).estado -eq 'rodando' }) 'J2 rodando'
    Iniciar S1 0.5 -Sozinho; Iniciar S2 0.5 -Sozinho
    Ok (Esperar { @((Ficha S1).seguras) -contains 'sozinho' }) 'S1 segura a pasta sozinho'
    Ok (Esperar { (Ficha S2).estado -eq 'espera' }) 'S2 na fila'
    Ok ((Ctl -Mover (Ficha S2).id topo) -eq 0) 'S2 para o topo'
    EsperarFim J2, S1, S2 30
    Ok ((T (Hist S2).comeco) -ge (T (Hist S1).fim).AddSeconds(-0.5)) 'S1 (que já segurava) rodou antes de S2'

    Write-Host '11. comando que não existe'
    $p = Start-Process pwsh -ArgumentList '-NoProfile', '-File', $fila, '-Nome', 'X', 'comando-que-nao-existe-xyz' -RedirectStandardOutput (Join-Path $raiz 'X.out') -NoNewWindow -PassThru
    $null = $p.Handle; $p.WaitForExit()
    Ok ($p.ExitCode -ne 0) "sai com código não zero ($($p.ExitCode))"
    Ok ($null -eq (Hist X)) 'não vai para o histórico'

    Write-Host '12. matar comando que roda dentro do próprio pwsh (.ps1 direto)'
    $out = Join-Path $raiz 'K.out'
    $p = Start-Process pwsh -ArgumentList '-NoProfile', '-File', $fila, '-Nome', 'K', $trab, '30', '0', 'K' -RedirectStandardOutput $out -NoNewWindow -PassThru
    $null = $p.Handle; $jobs['K'] = [pscustomobject]@{ nome = 'K'; proc = $p; out = $out }
    Ok (Esperar { (Ficha K).estado -eq 'rodando' }) 'K rodando'
    Ok ((Ficha K).emProcesso) 'K marcado como dentro do pwsh'
    $t = Get-Date
    Ok ((Ctl -Cancelar (Ficha K).id) -eq 0) 'matar K'
    EsperarFim K 15
    Ok (((Get-Date) - $t).TotalSeconds -lt 10) 'K morreu logo'
    Ok ($p.ExitCode -ne 0) "K saiu com código não zero ($($p.ExitCode))"
    Iniciar Z 0.3
    EsperarFim Z 10
    Ok ($null -ne (Hist Z)) 'vaga de K (morto) foi liberada'

    Write-Host '13. vaga com pid reaproveitado (início diferente) é quebrada'
    foreach ($v in 'lock', 'lock2') {
        New-Item -ItemType Directory -Force (Join-Path $env:FILA_BUILD_DIR $v) | Out-Null
        "$PID|reuso|$(Get-Date -Format o)|id-velho|1" | Set-Content (Join-Path $env:FILA_BUILD_DIR "$v\dono.txt")
    }
    Iniciar R 0.3
    EsperarFim R 10
    Ok ($null -ne (Hist R)) 'R rodou: as vagas do pid reaproveitado foram quebradas'

    Write-Host '9. invariantes'
    Ok ($maxVagas -le 2) "nunca mais de duas vagas em uso (máximo visto: $maxVagas)"
    Ok (-not (Test-Path (Join-Path $env:FILA_BUILD_DIR 'lock2'))) 'vagas soltas no fim'
} finally {
    foreach ($j in $jobs.Values) { if (-not $j.proc.HasExited) { & taskkill.exe /PID $j.proc.Id /T /F *> $null } }
    Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue
}
if ($falhas.Count) { Write-Host "`n$($falhas.Count) falha(s)" -ForegroundColor Red; exit 1 }
Write-Host "`ntudo passou"
exit 0
