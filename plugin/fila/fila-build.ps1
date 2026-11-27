# Fila de build por pontos: até 4 pontos em uso na máquina, em ordem, com painel (/fila no Claude Code).
#
# Rodar (como sempre):
#   pwsh -NoProfile -File ~/.claude/scripts/fila-build.ps1 -Nome <sessão> [-Sozinho] [-Tipo <tipo>] [-Peso 1-4] <comando> [args...]
#   Peso deduzido: Build 2, Teste com compilação (cargo test, nextest, ctest) 2, Jogo 1, Outro 1, Medição/-Sozinho 4.
#   -Peso corrige a dedução. -Tipo (Build, Teste, Jogo, Medição...) é opcional; sem ele vem do comando.
# Regra: até 2 pontos em uso entra sempre; passar de 2 exige CPU < 75% (média de uns 5 s) e RAM livre > 4 GB.
#   Pedido sozinho na máquina entra sempre. Quem está na frente e não cabe pode ser passado por um leve (peso 1)
#   só enquanto esperou menos de 3 min (FILA_PASSAR_SEGUNDOS); -Sozinho nunca é passado.
#   Dois pesados juntos: o que entra recebe CARGO_BUILD_JOBS=8 e CMAKE_BUILD_PARALLEL_LEVEL=8 se não vierem definidos.
# Controle (usado pelo painel):
#   fila-build.ps1 -Mover <id> topo|cima|baixo | -Cancelar <id> | -Pausar | -Soltar | -Limpar
#
# As opções só valem antes do comando e com o nome inteiro: o que vem depois é do comando (cargo -p, ninja -t).
# Dados em %LOCALAPPDATA%\fila-build (ou $env:FILA_BUILD_DIR, usado pelo teste):
#   fichas\<id>.json   um pedido: escrito só pelo dono, por troca atômica (rename)
#   fichas\<id>.cancelar   pedido de cancelamento vindo do painel
#   ordem.txt          ordem de espera que o painel reescreve; quem não está nela vai depois, por chegada
#   pausa              existindo, nada novo começa
#   lock, lock2, sozinho   vagas da versão antiga (de 2 vagas), que ainda pode estar rodando: lock e lock2
#                      valem 2 pontos cada enquanto existirem. A versão de pontos não cria pastas: os pontos em
#                      uso são as fichas 'rodando', e a decisão de entrar é tomada e gravada dentro da trava.
#   logs\<id>.log      saída de cada pedido; historico.jsonl  as últimas execuções
$ErrorActionPreference = 'Continue'
$argv = @($args)
$dir = if ($env:FILA_BUILD_DIR) { $env:FILA_BUILD_DIR } else { Join-Path $env:LOCALAPPDATA 'fila-build' }
$fichas = Join-Path $dir 'fichas'
$logs = Join-Path $dir 'logs'
$sessoes = Join-Path $dir 'sessoes'
$Vagas = @('lock', 'lock2')   # só da versão antiga
$Capacidade = 4
$LivreSempre = 2   # até aqui entra sem olhar a máquina
$PassarSeg = if ($env:FILA_PASSAR_SEGUNDOS) { [double]$env:FILA_PASSAR_SEGUNDOS } else { 180 }
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

# Trava entre processos para ordem.txt, o histórico e a decisão de entrar.
function Com-Trava([scriptblock]$sb) {
    $m = [Threading.Mutex]::new($false, 'Local\fila-build')
    $tem = $false
    try {
        try { $tem = $m.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $tem = $true }
        if (-not $tem) { throw 'fila-build: a trava da fila não soltou em 15 s' }
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

# Fila de espera na ordem: primeiro quem já segura alguma pasta (um -Sozinho da versão antiga), depois os ids
# de ordem.txt, na ordem dele, e os outros, por chegada (id).
function Ordem-Espera($lista) {
    $ord = @(Get-Content -LiteralPath (Join-Path $dir 'ordem.txt') -ErrorAction SilentlyContinue)
    $pos = @{}
    for ($k = 0; $k -lt $ord.Count; $k++) { if ($ord[$k] -and -not $pos.ContainsKey($ord[$k])) { $pos[$ord[$k]] = $k } }
    @($lista | Where-Object { $_.estado -eq 'espera' } |
        Sort-Object -Stable @{ e = { if (@($_.seguras).Count) { 0 } else { 1 } } }, @{ e = { if ($pos.ContainsKey($_.id)) { $pos[$_.id] } else { [int]::MaxValue } } }, @{ e = { $_.id } })
}

# Vaga antiga livre? Quebra a de dono morto. dono.txt = pid|nome|data[|id|início do processo]; a versão mais
# antiga grava só os três primeiros. Sem dono.txt legível há mais de 1 min (criação pela metade) também é morta.
function Vaga-Livre([string]$v) {
    $l = Join-Path $dir $v
    if (-not (Test-Path -LiteralPath $l)) { return $true }
    $dono = Get-Content -Raw -LiteralPath (Join-Path $l 'dono.txt') -ErrorAction SilentlyContinue
    $info = "$dono".Trim() -split '\|'
    $parado = if ($info.Count -ge 3) { -not (Vivo $info[0] $(if ($info.Count -ge 5) { $info[4] })) }
              else { ((Get-Date) - (Get-Item -LiteralPath $l).CreationTime).TotalMinutes -gt 1 }
    if ($parado) {
        # Renomear é atômico: só um processo quebra a vaga, e confere que ainda é a mesma morta;
        # se outro já a recriou nesse meio tempo, devolve.
        $q = "$l.quebra.$PID"
        try { [IO.Directory]::Move($l, $q) } catch { return $false }
        $agora = Get-Content -Raw -LiteralPath (Join-Path $q 'dono.txt') -ErrorAction SilentlyContinue
        if ("$agora" -ne "$dono") { try { [IO.Directory]::Move($q, $l) } catch {}; return $false }
        Remove-Item -LiteralPath $q -Recurse -Force -ErrorAction SilentlyContinue
    }
    -not (Test-Path -LiteralPath $l)
}

function Tipo-Do-Comando([string]$texto, [bool]$sozinho) {
    if ($sozinho) { return 'Medição' }
    $t = $texto.ToLowerInvariant()
    if ($t -match 'jogo-oculto|--hidden-window') { return 'Jogo' }
    if ($t -match '(?<![a-z])(c|py)?test(e|es|s)?(?![a-z])|nextest') { return 'Teste' }
    if ($t -match '\b(cargo|cmake|ninja|msbuild|make)\b') { return 'Build' }
    'Outro'
}

function Peso-Do-Comando([string]$texto, [string]$tipo) {
    switch ($tipo) {
        'Medição' { 4 }
        'Build' { 2 }
        'Teste' { if ($texto.ToLowerInvariant() -match '\bcargo\b|nextest|ctest') { 2 } else { 1 } }
        default { 1 }
    }
}

# Ficha da versão de vagas não tem peso: cada vaga vale 2.
function Peso-De($o) { if ($o.peso) { [int]$o.peso } else { [Math]::Min($Capacidade, 2 * [Math]::Max(1, [int]$o.vagas)) } }

# ---- conferência da máquina: uma amostra por volta do laço de espera; média da janela (~5 s) ----
$amostras = [Collections.Generic.List[object]]::new()
$medindo = $false
function Medir-Maquina {
    if ($env:FILA_TESTE_MAQUINA) { return }
    if (-not ('FilaMaquina' -as [type])) {
        Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class FilaMaquina {
    [DllImport("kernel32.dll")] public static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
    [StructLayout(LayoutKind.Sequential)] struct Mem { public uint len, load; public ulong total, avail, tp, ap, tv, av, ave; }
    [DllImport("kernel32.dll")] static extern bool GlobalMemoryStatusEx(ref Mem m);
    public static ulong Livre() { var m = new Mem(); m.len = (uint)Marshal.SizeOf(m); GlobalMemoryStatusEx(ref m); return m.avail; }
}
'@
    }
    $ocioso = 0L; $nucleo = 0L; $usuario = 0L
    $null = [FilaMaquina]::GetSystemTimes([ref]$ocioso, [ref]$nucleo, [ref]$usuario)
    $amostras.Add(@([DateTime]::UtcNow, $ocioso, ($nucleo + $usuario)))   # o tempo de núcleo já inclui o ocioso
    while ($amostras.Count -gt 6) { $amostras.RemoveAt(0) }
}

# CPU total abaixo de 75% e RAM livre acima de 4 GB? FILA_TESTE_MAQUINA='cpu,ramGB' simula (teste).
# A primeira chamada começa a medir e diz não: a média precisa de pelo menos 3 s de amostras.
function Maquina-Ok {
    if ($env:FILA_TESTE_MAQUINA) { $c, $r = $env:FILA_TESTE_MAQUINA -split ','; return [double]$c -lt 75 -and [double]$r -gt 4 }
    if (-not $script:medindo) { $script:medindo = $true; Medir-Maquina }
    $a = $amostras[0]; $b = $amostras[$amostras.Count - 1]
    if (($b[0] - $a[0]).TotalSeconds -lt 3) { return $false }
    $cpu = 100 * (1 - ($b[1] - $a[1]) / [Math]::Max(1, $b[2] - $a[2]))
    $cpu -lt 75 -and [FilaMaquina]::Livre() -gt 4GB
}

# Pontos em uso: fichas 'rodando' da versão de pontos mais 2 por vaga antiga (lock, lock2) de dono vivo.
function Pontos-Em-Uso($lista) {
    $n = 2 * @($Vagas | Where-Object { -not (Vaga-Livre $_) }).Count
    foreach ($o in $lista) { if ($o.estado -eq 'rodando' -and $o.peso) { $n += [int]$o.peso } }
    $n
}

# Este pedido entra agora? Anda pela ordem: quem está na frente e cabe fica com os pontos dele; quem não cabe
# segura todos atrás, menos um leve, e só enquanto esperou menos de $PassarSeg (sem fome). -Sozinho não é passado.
function Posso-Entrar($lista) {
    $usados = Pontos-Em-Uso $lista
    foreach ($o in Ordem-Espera $lista) {
        $p = Peso-De $o
        $cabe = $usados + $p -le $Capacidade -and ($usados -eq 0 -or $usados + $p -le $LivreSempre -or (Maquina-Ok))
        if ($o.id -eq $id) { return $cabe }
        if ($cabe) { $usados += $p; continue }
        if ($Peso -gt 1 -or $p -ge $Capacidade -or -not $o.criado -or ((Get-Date) - [DateTime]$o.criado).TotalSeconds -ge $PassarSeg) { return $false }
    }
    $false
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
            if (-not (Vivo $o.pid $o.inicioProc)) { "fila-build: '$alvo' já não está rodando"; exit 1 }
            # Mata a árvore do comando (filhos do script); o script segue, solta os pontos e grava o histórico.
            # Só filhos nascidos depois do script: um pid antigo reaproveitado não é filho dele.
            $nasceu = [DateTime]::new([long]$o.inicioProc, 'Utc')
            $achou = $false
            for ($t = 0; -not $o.emProcesso -and $t -lt 30; $t++) {
                $filhos = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$([int]$o.pid)" -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -ne 'conhost.exe' -and $_.CreationDate.ToUniversalTime() -ge $nasceu })
                if ($filhos.Count) { foreach ($c in $filhos) { & taskkill.exe /PID $c.ProcessId /T /F *> $null }; $achou = $true; break }
                Start-Sleep -Milliseconds 100
            }
            # Comando dentro do próprio pwsh (.ps1, função) ou sem filho para matar: mata o script inteiro.
            # Ele sai com código 1; a ficha de dono morto é limpa pelos outros.
            if (-not $achou) { & taskkill.exe /PID ([int]$o.pid) /T /F *> $null }
            "matando: $alvo"
        } else { "cancelado: $alvo" }
        exit 0
    }
}

# ---------------- rodar um comando pela fila ----------------
$Nome = $null; $Sozinho = $false; $Tipo = $null; $Peso = $null
$i = 0
while ($i -lt $argv.Count) {
    $a = "$($argv[$i])"
    if ($a -eq '-Nome' -and $i + 1 -lt $argv.Count) { $Nome = "$($argv[$i + 1])"; $i += 2 }
    elseif ($a -eq '-Tipo' -and $i + 1 -lt $argv.Count) { $Tipo = "$($argv[$i + 1])"; $i += 2 }
    elseif ($a -eq '-Peso' -and $i + 1 -lt $argv.Count) { $Peso = "$($argv[$i + 1])"; $i += 2 }
    elseif ($a -eq '-Sozinho') { $Sozinho = $true; $i++ }
    elseif ($a -eq '--') { $i++; break }
    else { break }
}
$Cmd = @($argv | Select-Object -Skip $i)
if (-not $Nome -or $Cmd.Count -eq 0 -or ($null -ne $Peso -and $Peso -notmatch '^[1-4]$')) {
    Write-Host 'uso: fila-build.ps1 -Nome <sessão> [-Sozinho] [-Tipo <tipo>] [-Peso 1-4] <comando> [args...]'
    exit 2
}
$qual = Get-Command $Cmd[0] -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $qual) {
    Write-Host "fila-build: comando não encontrado: $($Cmd[0])"
    exit 1
}
$textoCmd = ($Cmd | ForEach-Object { if ("$_" -match '\s') { "`"$_`"" } else { "$_" } }) -join ' '
if (-not $Tipo) { $Tipo = Tipo-Do-Comando $textoCmd $Sozinho }
$Peso = if ($Sozinho) { $Capacidade } elseif ($Peso) { [int]$Peso } else { Peso-Do-Comando $textoCmd $Tipo }
$id = '{0}-{1}' -f [DateTime]::Now.ToString('yyyyMMdd-HHmmss-fff'), $PID
$arqFicha = Join-Path $fichas "$id.json"
$arqCancelar = Join-Path $fichas "$id.cancelar"
$log = Join-Path $logs "$id.log"
$ficha = [ordered]@{
    id = $id; pid = $PID; inicioProc = (Inicio-Proc $PID); nome = $Nome; sessao = "$env:CLAUDE_CODE_SESSION_ID"
    tipo = $Tipo; cmd = $textoCmd; pasta = (Get-Location).Path; criado = (Agora); estado = 'espera'
    comeco = $null; peso = $Peso; log = $log
    vagas = [int][Math]::Ceiling($Peso / 2); seguras = @()   # lidos pela versão de vagas, que ainda pode estar esperando
    emProcesso = $qual.CommandType -ne 'Application'   # .ps1/função: Matar tem de matar o script
}
function Gravar-Ficha { Gravar-Atomico $arqFicha ($ficha | ConvertTo-Json -Compress) }

Gravar-Ficha
$avisou = $false
$cancelado = $false
try {
    while ($true) {
        if (Test-Path -LiteralPath $arqCancelar) { $cancelado = $true; break }
        if ($medindo) { Medir-Maquina }
        $lista = Ler-Fichas
        $pausada = Test-Path -LiteralPath (Join-Path $dir 'pausa')
        # Olha sem a trava; se parece que entra, confere de novo dentro dela e já grava 'rodando'.
        if ($null -ne $lista -and -not $pausada -and (Posso-Entrar $lista)) {
            $entrou = $false
            try {
                $entrou = Com-Trava {
                    $agora = Ler-Fichas
                    if ($null -eq $agora -or (Test-Path -LiteralPath (Join-Path $dir 'pausa')) -or -not (Posso-Entrar $agora)) { return $false }
                    $pesados = @($agora | Where-Object { $_.estado -eq 'rodando' -and $_.peso -ge 2 }).Count + @($Vagas | Where-Object { -not (Vaga-Livre $_) }).Count
                    if ($Peso -ge 2 -and $pesados -gt 0) {
                        foreach ($v in 'CARGO_BUILD_JOBS', 'CMAKE_BUILD_PARALLEL_LEVEL') {
                            if (-not [Environment]::GetEnvironmentVariable($v)) { [Environment]::SetEnvironmentVariable($v, '8') }
                        }
                        Write-Host "fila-build: outro pesado rodando; CARGO_BUILD_JOBS=$env:CARGO_BUILD_JOBS CMAKE_BUILD_PARALLEL_LEVEL=$env:CMAKE_BUILD_PARALLEL_LEVEL"
                    }
                    $ficha.estado = 'rodando'; $ficha.comeco = Agora
                    Gravar-Ficha
                    $true
                }
            } catch { Write-Host "fila-build: $_" }
            if ($entrou) { break }
        }
        if (-not $avisou -and $null -ne $lista) {
            $pos = [Array]::IndexOf(@((Ordem-Espera $lista) | ForEach-Object { $_.id }), $id) + 1
            $rodando = @($lista | Where-Object { $_.estado -eq 'rodando' } | ForEach-Object { $_.nome })
            $pausa = if ($pausada) { ' (fila PAUSADA no painel)' } else { '' }
            Write-Host "fila-build: na fila em #$pos (id $id, $Peso ponto(s); em uso $(Pontos-Em-Uso $lista)/$Capacidade)$pausa; rodando agora: '$($rodando -join "', '")'"
            $avisou = $true
        }
        Start-Sleep -Seconds 1
    }
    # Cancelado logo depois de entrar: a bandeira pode ter chegado entre a última olhada e a gravação.
    if (-not $cancelado) { $cancelado = Test-Path -LiteralPath $arqCancelar }
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
        # @resto (variável) espalha os argumentos; @(...) passaria um array só a um .ps1 ou função.
        $resto = @($Cmd | Select-Object -Skip 1)
        & $Cmd[0] @resto 2>&1 | ForEach-Object {
            $s = if ($_ -is [System.Management.Automation.ErrorRecord]) { "$_" } else { $_ }
            $linha = "$s"
            try { $linha = $utf8Estrito.GetString($enc.GetBytes($linha)) } catch {}
            $w.WriteLine($linha)
            $s
        }
        $codigo = $LASTEXITCODE
    } catch {
        Write-Host "fila-build: o comando parou com erro: $_"
        $codigo = 1
    } finally {
        $w.Dispose()
        $morto = Test-Path -LiteralPath $arqCancelar
        $fim = Get-Date
        $reg = [ordered]@{
            id = $id; nome = $Nome; sessao = $ficha.sessao; tipo = $Tipo; peso = $Peso; cmd = $textoCmd; pasta = $ficha.pasta
            comeco = $ficha.comeco; fim = $fim.ToString('o'); segundos = [Math]::Round(($fim - $t0).TotalSeconds, 1)
            codigo = $(if ($null -eq $codigo) { if ($morto) { -1 } else { 0 } } else { $codigo }); cancelado = $morto; log = $log
        }
        Remove-Item -LiteralPath $arqFicha -Force -ErrorAction SilentlyContinue   # solta os pontos
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
    Remove-Item -LiteralPath $arqFicha, $arqCancelar -Force -ErrorAction SilentlyContinue
}
