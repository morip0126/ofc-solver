import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * 描画エラーで白画面にしないための最上位エラー境界。
 * 言語設定は App 内部の state なのでここでは参照できない。両言語を併記する。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <main className="app">
        <section className="panel">
          <h1>エラーが発生しました / Something went wrong</h1>
          <p className="hint error">{this.state.error.message || String(this.state.error)}</p>
          <button type="button" className="primary-btn" onClick={() => location.reload()}>
            再読み込み / Reload
          </button>
        </section>
      </main>
    )
  }
}
