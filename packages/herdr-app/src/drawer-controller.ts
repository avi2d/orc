export type DrawerPane = "raw" | "turns"

export interface DrawerChat {
  readonly address: string
  readonly session: string
}

export interface DrawerTerminal {
  readonly start: () => Promise<DrawerChat>
  readonly live: (chat: DrawerChat) => Promise<boolean>
  readonly stop: (chat: DrawerChat) => Promise<void>
}

interface DrawerHost extends DrawerTerminal {
  readonly show: (pane: DrawerPane, chat: DrawerChat) => string
  readonly hide: (overlay: string) => void
}

export class DrawerController {
  private chat: DrawerChat | null = null
  private overlay: string | null = null
  private disposed = false

  private readonly host: DrawerHost

  constructor(host: DrawerHost) {
    this.host = host
  }

  private hide(): void {
    const overlay = this.overlay
    this.overlay = null
    if (overlay !== null) this.host.hide(overlay)
  }

  private stop(): Promise<void> {
    const chat = this.chat
    if (chat === null) return Promise.resolve()
    return this.host.stop(chat).then(() => {
      if (this.chat === chat) this.chat = null
    })
  }

  dispose(): Promise<void> {
    this.disposed = true
    this.hide()
    return this.stop()
  }

  private open(view: DrawerPane): Promise<void> {
    const chat = this.chat
    const live = chat !== null && this.overlay !== null ? this.host.live(chat) : Promise.resolve(false)
    return live.then((running) => {
      if (running && chat !== null) return chat
      return this.stop().then(() => this.disposed ? null : this.host.start())
    }).then((terminal) => {
      if (terminal === null) return
      this.chat = terminal
      if (this.disposed) return this.stop()
      this.hide()
      try {
        this.overlay = this.host.show(view, terminal)
      } catch (error) {
        return this.stop().then(() => { throw error })
      }
    })
  }

  obey(command: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (command === "gone:" + this.overlay && this.overlay !== null) {
      this.overlay = null
      return this.stop()
    }
    if (command === "close" || (command === "toggle" && this.overlay !== null)) {
      this.hide()
      return this.stop()
    }
    if (command === "toggle" || command === "show:raw") return this.open("raw")
    if (command === "show:turns") return this.open("turns")
    return Promise.resolve()
  }
}
