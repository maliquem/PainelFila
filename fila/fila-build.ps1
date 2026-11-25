# Fila de build: no máximo duas por vez na máquina, em ordem, com painel (/fila no Claude Code).
#
# Rodar (como sempre):
#   pwsh -NoProfile -File ~/.claude/scripts/fila-build.ps1 -Nome <sessão> [-Sozinho] [-Tipo <tipo>] <comando> [args...]
#   -Sozinho ocupa as duas vagas (medição) e segura cada vaga que se libera até ter as duas.
#   -Tipo (Build, Teste, Jogo, Medição...) é opcional; sem ele vem do comando.
# Controle (usado pelo painel):
#   fila-build.ps1 -Mover <id> topo|cima|baixo | -Cancelar <id> | -Pausar | -Soltar | -Limpar
#
# As opções só valem antes do comando e com o nome inteiro: o que vem depois é do comando (cargo -p, ninja -t).
# Dados em %LOCALAPPDATA%\fila-build (ou $env:FILA_BUILD_DIR, usado pelo teste):
#   fichas\<id>.json   um pedido: escrito só pelo dono, por troca atômica (rename)
#   fichas\<id>.cancelar   pedido de cancelamento vindo do painel
#   ordem.txt          ordem de espera que o painel reescreve; quem não está nela vai depois, por chegada
#   pausa              existindo, nada novo começa
#   lock, lock2, sozinho   as vagas (pastas): as mesmas da versão antiga, que ainda pode estar rodando
#   logs\<id>.log      saída de cada pedido; historico.jsonl  as últimas execuções
$ErrorActionPreference = 'Continue'
$argv = @($args)
$dir = if ($env:FILA_BUILD_DIR) { $env:FILA_BUILD_DIR } else { Join-Path $env:LOCALAPPDATA 'fila-build' }
$fichas = Join-Path $dir 'fichas'
$logs = Join-Path $dir 'logs'
$sessoes = Join-Path $dir 'sessoes'
$Vagas = @('lock', 'lock2')
New-Item -ItemType Directory -Force $fichas, $logs | Out-Null

function Agora { [DateTime]::Now.ToString('o') }

function Gravar-Atomico([string]$path, [string]$text) {
    $tmp = "$path.$PID.tmp"
    [IO.File]::WriteAllText($tmp, $text, [Text.UTF8Encoding]::new($false))
    for ($k = 0; $k -lt 40; $k++) {
        try { [IO.File]::Move($tmp, $path, $true); return } catch { Start-Sleep -Milliseconds 50 }
    }
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    throw "fila-build: não consegui gravar $path"
}

function Ler-Json([string]$p) {
    try { Get-Content -Raw -LiteralPath $p -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch { $null }
}

# Trava entre processos para ordem.txt e o histórico (os dois têm mais de um escritor).
function Com-Trava([scriptblock]$sb) {
    $m = [Threading.Mutex]::new($false, 'Local\fila-build')
    $tem = $false
    try {
        try { $tem = $m.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $tem = $true }
        & $sb
    } finally {
        if ($tem) { $m.ReleaseMutex() }
        $m.Dispose()
    }
}

function Inicio-Proc([int]$procId) {
    try { (Get-Process -Id $procId -ErrorAction Stop).StartTime.ToUniversalTime().Ticks } catch { 0 }
}

function Vivo($procId, $inicio) {
    if (-not $procId) { return $false }
    $p = Get-Process -Id ([int]$procId) -ErrorAction SilentlyContinue
    if (-not $p) { return $false }
    # Confere o horário de início: um pid reaproveitado por outro processo conta como morto.
    if ($inicio) { try { return $p.StartTime.ToUniversalTime().Ticks -eq [long]$inicio } catch { return $true } }
    $true
}

# Lê todas as fichas; as de dono morto são apagadas. Devolve $null se alguma está ilegível agora
# (quem decide a vez espera a próxima volta em vez de decidir com a fila pela metade).
function Ler-Fichas {
    $lista = [Collections.Generic.List[object]]::new()
    foreach ($f in Get-ChildItem -LiteralPath $fichas -Filter '*.json' -File -ErrorAction SilentlyContinue) {
        $o = Ler-Json $f.FullName
        if (-not $o) { Start-Sleep -Milliseconds 100; $o = Ler-Json $f.FullName }
        if (-not $o) {
            if (-not (Test-Path -LiteralPath $f.FullName)) { continue }
            if (((Get-Date) - $f.LastWriteTime).TotalSeconds -gt 30) { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue; continue }
            return $null
        }
        if (-not (Vivo $o.pid $o.inicioProc)) {
            Remove-Item -LiteralPath $f.FullName, (Join-Path $fichas "$($o.id).cancelar") -Force -ErrorAction SilentlyContinue
            continue
        }
        $lista.Add($o)
    }
    , $lista.ToArray()
}

# Fila de espera na ordem: primeiro os ids de ordem.txt, na ordem dele; depois os outros, por chegada (id).
function Ordem-Espera($lista) {
    $ord = @(Get-Content -LiteralPath (Join-Path $dir 'ordem.txt') -ErrorAction SilentlyContinue)
    $pos = @{}
    for ($k = 0; $k -lt $ord.Count; $k++) { if ($ord[$k] -and -not $pos.ContainsKey($ord[$k])) { $pos[$ord[$k]] = $k } }
    @($lista | Where-Object { $_.estado -eq 'espera' } |
        Sort-Object -Stable @{ e = { if ($pos.ContainsKey($_.id)) { $pos[$_.id] } else { [int]::MaxValue } } }, @{ e = { $_.id } })
}

# Vaga livre? Quebra a de dono morto (pid na 1ª parte de dono.txt, como na versão antiga).
function Vaga-Livre([string]$v) {
    $l = Join-Path $dir $v
    if (-not (Test-Path -LiteralPath $l)) { return $true }
    $info = (Get-Content -LiteralPath (Join-Path $l 'dono.txt') -ErrorAction SilentlyContinue) -split '\|'
    $parado = if ($info.Count -ge 3) { -not (Get-Process -Id ([int]$info[0]) -ErrorAction SilentlyContinue) }
              else { ((Get-Date) - (Get-Item -LiteralPath $l).CreationTime).TotalMinutes -gt 1 }
    if ($parado) { Remove-Item -LiteralPath $l -Recurse -Force -ErrorAction SilentlyContinue }
    -not (Test-Path -LiteralPath $l)
}

function Pegar-Pasta([string]$v) {
    $l = Join-Path $dir $v
    if (-not (Vaga-Livre $v)) { return $false }
    try { New-Item -ItemType Directory -Path $l -ErrorAction Stop | Out-Null } catch { return $false }
    "$PID|$Nome|$(Agora)|$id" | Set-Content -LiteralPath (Join-Path $l 'dono.txt')
    $true
}

function Tipo-Do-Comando([string]$texto, [bool]$sozinho) {
    if ($sozinho) { return 'Medição' }
    $t = $texto.ToLowerInvariant()
    if ($t -match 'jogo-oculto|--hidden-window') { return 'Jogo' }
    if ($t -match '(?<![a-z])(c|py)?test(e|es|s)?(?![a-z])|nextest') { return 'Teste' }
    if ($t -match '\b(cargo|cmake|ninja|msbuild|make)\b') { return 'Build' }
    'Outro'
}

function Limpar-Tudo {
    $null = Ler-Fichas
    foreach ($v in $Vagas + 'sozinho') { $null = Vaga-Livre $v }
    foreach ($f in Get-ChildItem -LiteralPath $sessoes -Filter '*.json' -File -ErrorAction SilentlyContinue) {
        $o = Ler-Json $f.FullName
        if ($o -and ($o.encerrada -or -not (Vivo $o.pid $null))) { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue }
    }
    foreach ($f in Get-ChildItem -LiteralPath $dir, $fichas, $sessoes -Filter '*.tmp' -File -ErrorAction SilentlyContinue) {
        if (((Get-Date) - $f.LastWriteTime).TotalMinutes -gt 1) { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue }
    }
    Get-ChildItem -LiteralPath $logs -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-3) } | Remove-Item -Force -ErrorAction SilentlyContinue
}

# ---------------- comandos de controle (painel) ----------------
switch ($argv[0]) {
    '-Pausar' { New-Item -ItemType File -Force (Join-Path $dir 'pausa') | Out-Null; 'fila pausada'; exit 0 }
    '-Soltar' { Remove-Item -LiteralPath (Join-Path $dir 'pausa') -Force -ErrorAction SilentlyContinue; 'fila solta'; exit 0 }
    '-Limpar' { Limpar-Tudo; exit 0 }
    '-Mover' {
        $alvo = $argv[1]; $para = "$($argv[2])".ToLowerInvariant()
        if ($para -notin 'topo', 'cima', 'baixo') { 'uso: -Mover <id> topo|cima|baixo'; exit 2 }
        $ok = Com-Trava {
            $lista = Ler-Fichas
            if ($null -eq $lista) { Start-Sleep -Milliseconds 300; $lista = Ler-Fichas }
            if ($null -eq $lista) { return $false }
            $ids = [Collections.Generic.List[string]]@((Ordem-Espera $lista) | ForEach-Object { $_.id })
            $i = $ids.IndexOf($alvo)
            if ($i -lt 0) { return $false }
            $ids.RemoveAt($i)
            $novo = switch ($para) { 'topo' { 0 } 'cima' { [Math]::Max(0, $i - 1) } 'baixo' { [Math]::Min($ids.Count, $i + 1) } }
            $ids.Insert($novo, $alvo)
            Gravar-Atomico (Join-Path $dir 'ordem.txt') (($ids -join "`n") + "`n")
            $true
        }
        if ($ok) { "movido: $alvo $para"; exit 0 } else { "fila-build: '$alvo' não está esperando na fila"; exit 1 }
    }
    '-Cancelar' {
        $alvo = $argv[1]
        $arq = Join-Path $fichas "$alvo.json"
        if (-not $alvo -or -not (Test-Path -LiteralPath $arq)) { "fila-build: '$alvo' não está na fila"; exit 1 }
        # A bandeira vem antes de olhar o estado: quem começar depois dela vê a bandeira e não roda.
        New-Item -ItemType File -Force (Join-Path $fichas "$alvo.cancelar") | Out-Null
        $o = Ler-Json $arq
        if ($o -and $o.estado -eq 'rodando') {
            # Mata a árvore do comando (filhos do script); o script segue, solta a vaga e grava o histórico.
            for ($t = 0; $t -lt 30; $t++) {
                $filhos = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$([int]$o.pid)" -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -ne 'conhost.exe' })
                if ($filhos.Count) { foreach ($c in $filhos) { & taskkill.exe /PID $c.ProcessId /T /F *> $null }; break }
                Start-Sleep -Milliseconds 100
            }
            "matando: $alvo"
        } else { "cancelado: $alvo" }
        exit 0
    }
}

# ---------------- rodar um comando pela fila ----------------
$Nome = $null; $Sozinho = $false; $Tipo = $null
$i = 0
while ($i -lt $argv.Count) {
    $a = "$($argv[$i])"
    if ($a -eq '-Nome' -and $i + 1 -lt $argv.Count) { $Nome = "$($argv[$i + 1])"; $i += 2 }
    elseif ($a -eq '-Tipo' -and $i + 1 -lt $argv.Count) { $Tipo = "$($argv[$i + 1])"; $i += 2 }
    elseif ($a -eq '-Sozinho') { $Sozinho = $true; $i++ }
    elseif ($a -eq '--') { $i++; break }
    else { break }
}
$Cmd = @($argv | Select-Object -Skip $i)
if (-not $Nome -or $Cmd.Count -eq 0) {
    Write-Host 'uso: fila-build.ps1 -Nome <sessão> [-Sozinho] [-Tipo <tipo>] <comando> [args...]'
    exit 2
}
$textoCmd = ($Cmd | ForEach-Object { if ("$_" -match '\s') { "`"$_`"" } else { "$_" } }) -join ' '
if (-not $Tipo) { $Tipo = Tipo-Do-Comando $textoCmd $Sozinho }
$quero = if ($Sozinho) { $Vagas.Count } else { 1 }
$id = '{0}-{1}' -f [DateTime]::Now.ToString('yyyyMMdd-HHmmss-fff'), $PID
$arqFicha = Join-Path $fichas "$id.json"
$arqCancelar = Join-Path $fichas "$id.cancelar"
$log = Join-Path $logs "$id.log"
$ficha = [ordered]@{
    id = $id; pid = $PID; inicioProc = (Inicio-Proc $PID); nome = $Nome; sessao = "$env:CLAUDE_CODE_SESSION_ID"
    tipo = $Tipo; cmd = $textoCmd; pasta = (Get-Location).Path; criado = (Agora); estado = 'espera'
    comeco = $null; vagas = $quero; seguras = @(); log = $log
}
function Gravar-Ficha { Gravar-Atomico $arqFicha ($ficha | ConvertTo-Json -Compress) }

$minhas = [Collections.Generic.List[string]]::new()   # pastas de vaga que este pedido segura
function Soltar-Vagas { foreach ($l in $minhas) { Remove-Item -LiteralPath (Join-Path $dir $l) -Recurse -Force -ErrorAction SilentlyContinue }; $minhas.Clear() }

Gravar-Ficha
$avisou = $false
$cancelado = $false
try {
    while ($minhas.Count -lt $quero + [int]$Sozinho) {
        if (Test-Path -LiteralPath $arqCancelar) { $cancelado = $true; break }
        $lista = Ler-Fichas
        if ($null -ne $lista -and -not (Test-Path -LiteralPath (Join-Path $dir 'pausa'))) {
            $fila = Ordem-Espera $lista
            # Vagas livres menos o que falta a quem está na frente: só os primeiros da ordem entram.
            $saldo = @($Vagas | Where-Object { $minhas -notcontains $_ -and (Vaga-Livre $_) }).Count
            foreach ($o in $fila) {
                if ($o.id -eq $id) { break }
                $saldo -= [Math]::Max(0, [int]$o.vagas - @($o.seguras).Count)
            }
            if ($saldo -ge 1) {
                # -Sozinho pega antes a pasta 'sozinho' (só um por vez, também contra a versão antiga),
                # senão dois -Sozinho ficariam com uma vaga cada esperando o outro.
                if ($Sozinho -and $minhas -notcontains 'sozinho') { if (Pegar-Pasta 'sozinho') { $minhas.Add('sozinho') } }
                if (-not $Sozinho -or $minhas -contains 'sozinho') {
                    foreach ($v in $Vagas) {
                        if ($minhas -notcontains $v -and (Pegar-Pasta $v)) {
                            $minhas.Add($v)
                            $ficha.seguras = @($minhas | Where-Object { $_ -ne 'sozinho' })
                            Gravar-Ficha
                            break
                        }
                    }
                }
            }
            if ($minhas.Count -ge $quero + [int]$Sozinho) { break }
        }
        if (-not $avisou -and $null -ne $lista) {
            $pos = [Array]::IndexOf(@((Ordem-Espera $lista) | ForEach-Object { $_.id }), $id) + 1
            $rodando = @($lista | Where-Object { $_.estado -eq 'rodando' } | ForEach-Object { $_.nome })
            $pausa = if (Test-Path -LiteralPath (Join-Path $dir 'pausa')) { ' (fila PAUSADA no painel)' } else { '' }
            Write-Host "fila-build: na fila em #$pos (id $id)$pausa; rodando agora: '$($rodando -join "', '")'"
            $avisou = $true
        }
        Start-Sleep -Seconds 1
    }
    if (-not $cancelado) {
        $ficha.estado = 'rodando'; $ficha.comeco = Agora
        Gravar-Ficha
        $cancelado = Test-Path -LiteralPath $arqCancelar
    }
    if ($cancelado) {
        Write-Host "fila-build: '$Nome' foi cancelado no painel antes de começar; o comando NÃO rodou."
        exit 1
    }

    $t0 = Get-Date
    $codigo = $null
    # Log compartilhado para leitura (o painel lê enquanto roda), um flush por linha.
    $w = [IO.StreamWriter]::new([IO.FileStream]::new($log, 'Append', 'Write', 'ReadWrite'), [Text.UTF8Encoding]::new($false))
    $w.AutoFlush = $true
    $enc = [Console]::OutputEncoding
    $utf8Estrito = [Text.UTF8Encoding]::new($false, $true)
    try {
        # A saída vai para a sessão como antes e também para o log; stderr vira texto.
        # O pwsh lê a saída do comando pela página de código do console (ibm850 aqui): para a sessão os
        # bytes voltam iguais; no log, bytes que são UTF-8 válido (cargo) são lidos como UTF-8.
        & $Cmd[0] @($Cmd | Select-Object -Skip 1) 2>&1 | ForEach-Object {
            $s = if ($_ -is [System.Management.Automation.ErrorRecord]) { "$_" } else { $_ }
            $linha = "$s"
            try { $linha = $utf8Estrito.GetString($enc.GetBytes($linha)) } catch {}
            $w.WriteLine($linha)
            $s
        }
        $codigo = $LASTEXITCODE
    } finally {
        $w.Dispose()
        $morto = Test-Path -LiteralPath $arqCancelar
        $fim = Get-Date
        $reg = [ordered]@{
            id = $id; nome = $Nome; sessao = $ficha.sessao; tipo = $Tipo; cmd = $textoCmd; pasta = $ficha.pasta
            comeco = $ficha.comeco; fim = $fim.ToString('o'); segundos = [Math]::Round(($fim - $t0).TotalSeconds, 1)
            codigo = $(if ($null -eq $codigo) { if ($morto) { -1 } else { 0 } } else { $codigo }); cancelado = $morto; log = $log
        }
        Soltar-Vagas
        try {
            Com-Trava {
                $h = Join-Path $dir 'historico.jsonl'
                [IO.File]::AppendAllText($h, ($reg | ConvertTo-Json -Compress) + "`n", [Text.UTF8Encoding]::new($false))
                $linhas = [IO.File]::ReadAllLines($h)
                if ($linhas.Count -gt 400) { Gravar-Atomico $h ((($linhas | Select-Object -Last 200) -join "`n") + "`n") }
            }
        } catch { Write-Host "fila-build: não gravei o histórico: $_" }
    }
    if ($morto) {
        Write-Host "fila-build: '$Nome' foi morto pelo painel (Cancelar/Matar)."
        exit $(if ($codigo) { $codigo } else { 1 })
    }
    exit $codigo
} finally {
    Soltar-Vagas
    Remove-Item -LiteralPath $arqFicha, $arqCancelar -Force -ErrorAction SilentlyContinue
}
