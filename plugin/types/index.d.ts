// Um pedido da fila (fichas\<id>.json, escrito por fila-build.ps1).
export type Ficha = {
  id: string
  pid: number
  nome: string
  sessao: string
  tipo: string
  cmd: string
  pasta: string
  criado: string
  estado: 'espera' | 'rodando'
  comeco: string | null
  vagas: number
  seguras: string[]
  log: string
  emProcesso?: boolean
}

// Uma linha de historico.jsonl.
export type Hist = {
  id: string
  nome: string
  sessao: string
  tipo: string
  cmd: string
  pasta: string
  comeco: string
  fim: string
  segundos: number
  codigo: number
  cancelado: boolean
  log: string
}

// Uma tarefa de fundo de uma sessão (do evento Stop ou de uma chamada em segundo plano).
export type Tarefa = {
  id: string
  type: string
  status: string
  description: string
  command?: string
  agent_type?: string
  desde?: number
}

// sessoes\<id>.json, escrito pelo mod em cada sessão.
export type Sessao = {
  sessao: string
  nome: string
  pasta: string
  pid: number
  atualizado: number
  encerrada?: boolean
  tarefas: Tarefa[]
}

// Vaga segurada pela versão antiga do script (lock\dono.txt sem id).
export type Velha = { vaga: string; nome: string; desde: string }

export type Foto = {
  agora: number
  pausada: boolean
  rodando: Ficha[]
  fila: Ficha[]
  velhas: Velha[]
  sessoes: Sessao[]
  historico: Hist[]
  log?: { id: string; titulo: string; linhas: string[] }
  erro?: string
}

declare module 'claude-code' {
  interface PluginState {
    'painel-fila': {
      foto: Shaped<Foto | null>
      logDe: string
      ultimoFim: string
      minhas: Tarefa[]
      nomeSessao: string
      aviso: string
    }
  }
}
