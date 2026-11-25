// Contas puras do painel (sem $): testadas em tests/logica.test.ts.
import type { Ficha, Hist, Sessao, Tarefa } from '../types'

// Mesma regra do fila-build.ps1: quem já segura alguma pasta vai na frente; depois a ordem de ordem.txt
// e os outros por chegada (id).
export function ordenarFila(fichas: readonly Ficha[], ordem: readonly string[]): Ficha[] {
  const pos = new Map<string, number>()
  ordem.forEach((id, i) => {
    if (id && !pos.has(id)) pos.set(id, i)
  })
  const espera = fichas.filter(f => f.estado === 'espera')
  const segura = (f: Ficha) => (f.seguras?.length ? 0 : 1)
  return espera.sort((a, b) => {
    if (segura(a) !== segura(b)) return segura(a) - segura(b)
    const pa = pos.get(a.id) ?? Number.MAX_SAFE_INTEGER
    const pb = pos.get(b.id) ?? Number.MAX_SAFE_INTEGER
    return pa !== pb ? pa - pb : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

// Mesma dedução de tipo do fila-build.ps1, para as tarefas de fundo de shell.
export function tipoDoComando(cmd: string): string {
  const t = cmd.toLowerCase()
  if (/jogo-oculto|--hidden-window/.test(t)) return 'Jogo'
  if (/(?<![a-z])(c|py)?test(e|es|s)?(?![a-z])|nextest/.test(t)) return 'Teste'
  if (/\b(cargo|cmake|ninja|msbuild|make)\b/.test(t)) return 'Build'
  return 'Comando'
}

export function tipoDaTarefa(t: Tarefa): string {
  if (t.type === 'shell') return tipoDoComando(t.command ?? t.description)
  if (t.type === 'subagent') return t.agent_type ? `Subagente (${t.agent_type})` : 'Subagente'
  if (t.type === 'monitor') return 'Monitor'
  if (t.type === 'workflow') return 'Workflow'
  return t.type
}

// Tarefa de shell que chama a fila já aparece na fila: não repete em "outras".
export function ehDaFila(t: Tarefa): boolean {
  return t.type === 'shell' && /fila-build/i.test(t.command ?? '')
}

// Média das últimas 5 execuções terminadas do mesmo tipo e projeto, em segundos.
export function estimativa(hist: readonly Hist[], tipo: string, pasta: string): number | undefined {
  const iguais = hist
    .filter(h => !h.cancelado && h.tipo === tipo && h.pasta.toLowerCase() === pasta.toLowerCase())
    .slice(-5)
  if (iguais.length === 0) return undefined
  return iguais.reduce((s, h) => s + h.segundos, 0) / iguais.length
}

export function dur(segundos: number): string {
  const s = Math.max(0, Math.round(segundos))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export function desde(iso: string | null | undefined, agora: number): number {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? 0 : (agora - t) / 1000
}

// Comando curto: caminhos viram só o nome do arquivo, e corta no tamanho.
export function curto(cmd: string, n = 60): string {
  const s = cmd.replace(/"?(?:[A-Za-z]:)?(?:[\\/~][^\s"\\/]*)*[\\/]([^\s"\\/]+)"?/g, '$1').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

export function ultimasLinhas(texto: string, n: number): string[] {
  const linhas = texto.replace(/\r/g, '').split('\n')
  if (linhas.at(-1) === '') linhas.pop()
  return linhas.slice(-n)
}

// Nome da sessão como o app mostra: o último customTitle da transcrição.
export function tituloDaTranscricao(texto: string): string | undefined {
  let ultimo: string | undefined
  for (const m of texto.matchAll(/"customTitle":"((?:[^"\\]|\\.)*)"/g)) ultimo = m[1]
  if (ultimo === undefined) return undefined
  try {
    return JSON.parse(`"${ultimo}"`) as string
  } catch {
    return ultimo
  }
}

export function lerHistorico(texto: string): Hist[] {
  const lista: Hist[] = []
  for (const linha of texto.split('\n')) {
    if (!linha.trim().startsWith('{')) continue
    try {
      lista.push(JSON.parse(linha) as Hist)
    } catch {
      // linha cortada (leitura pelo meio do arquivo ou escrita em andamento)
    }
  }
  return lista
}

// fim vem em hora local com fuso (-03:00): compara como data, nunca como texto.
export function novosNoHistorico(hist: readonly Hist[], ultimoFim: string): Hist[] {
  const corte = Date.parse(ultimoFim)
  return hist.filter(h => Date.parse(h.fim) > corte)
}

export function fimMaisNovo(hist: readonly Hist[]): string | undefined {
  let melhor: Hist | undefined
  for (const h of hist) if (!melhor || Date.parse(h.fim) > Date.parse(melhor.fim)) melhor = h
  return melhor?.fim
}

export function textoDoAviso(h: Hist): string {
  const quem = `${h.tipo} '${h.nome}'`
  if (h.cancelado) return `■ ${quem} foi cancelado (código ${h.codigo}, ${dur(h.segundos)})`
  if (h.codigo === 0) return `✓ ${quem} terminou (código 0, ${dur(h.segundos)})`
  return `✗ ${quem} falhou (código ${h.codigo}, ${dur(h.segundos)})`
}

// "claude-opus-5-5[1m]" + "high" -> "Opus 5.5 High"; um apelido ("haiku") vira "Haiku".
export function nomeDoModelo(modelo: string | undefined, esforco?: string): string {
  const m = (modelo ?? '').toLowerCase().match(/(opus|sonnet|haiku|fable)(?:-(\d+)(?:-(\d{1,2})(?!\d))?)?/)
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1)
  const nome = m ? `${cap(m[1]!)}${m[2] ? ` ${m[2]}${m[3] ? `.${m[3]}` : ''}` : ''}` : (modelo ?? '')
  const esf = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' }[esforco ?? ''] ?? ''
  return [nome, esf].filter(Boolean).join(' ')
}

// Tarefas de fundo que a sessão mostra embaixo dela: nem as da fila (já estão lá) nem os subagentes que ela já lista.
export function tarefasDaSessao(s: Sessao): Tarefa[] {
  const subs = s.subagentes ?? []
  return s.tarefas.filter(
    t => !ehDaFila(t) && !(t.type === 'subagent' && subs.some(a => a.id === t.id || a.descricao === t.description)),
  )
}

export function sessaoAtiva(s: Sessao): boolean {
  return !!(s.trabalhando || s.esperando || s.subagentes?.length || tarefasDaSessao(s).length)
}

// Sessões ativas em árvore: cada filha logo abaixo da mãe (nivel + 1). Filha de mãe inativa sobe para a raiz.
export function arvoreDeSessoes(sessoes: readonly Sessao[]): { s: Sessao; nivel: number }[] {
  const ativas = sessoes.filter(sessaoAtiva)
  const ids = new Set(ativas.map(s => s.ccd).filter(Boolean))
  const saida: { s: Sessao; nivel: number }[] = []
  const vistos = new Set<Sessao>()
  const descer = (s: Sessao, nivel: number) => {
    if (vistos.has(s)) return // ciclo: nunca deveria haver, mas não trava o painel
    vistos.add(s)
    saida.push({ s, nivel })
    if (s.ccd) for (const f of ativas) if (f.ccdPai === s.ccd) descer(f, nivel + 1)
  }
  for (const s of ativas) if (!s.ccdPai || !ids.has(s.ccdPai)) descer(s, 0)
  return saida
}

// Uma sessão como o list_sessions do app a mostra.
export type DoApp = { sessionId: string; title?: string; cwd?: string }

// Qual das sessões do app é esta: pelo título; a pasta desempata e é obrigatória quando o nome é só o da pasta
// (sessão sem título), para não abrir outra que se chame igual. Na dúvida, nenhuma.
export function idNaLista(lista: readonly DoApp[], s: Pick<Sessao, 'nome' | 'pasta'>): string | undefined {
  const iguais = lista.filter(x => x.title === s.nome)
  const semTitulo = s.pasta.split(/[\\/]/).filter(Boolean).at(-1) === s.nome
  const achadas =
    iguais.length > 1 || semTitulo ? iguais.filter(x => x.cwd?.toLowerCase() === s.pasta.toLowerCase()) : iguais
  return achadas.length === 1 ? achadas[0]?.sessionId : undefined
}

// Barra de progresso em texto, para caber na linha do comando: "▰▰▰▱▱▱".
export function barra(feito: number, total: number, n = 6): string {
  const k = total > 0 ? Math.max(0, Math.min(n, Math.round((feito / total) * n))) : 0
  return '▰'.repeat(k) + '▱'.repeat(n - k)
}
