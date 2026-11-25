// Contas puras do painel (sem $): testadas em tests/logica.test.ts.
import type { Ficha, Hist, Tarefa } from '../types'

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
