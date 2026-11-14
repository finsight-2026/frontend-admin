import { Button, Result } from 'antd'
import { Component, type ReactNode } from 'react'

export default class AdminScreenErrorBoundary extends Component<{ children: ReactNode; onClose?: () => void }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children

    const { onClose } = this.props
    return <Result status="error" title="화면을 열지 못했어요."
      subTitle={onClose ? '받은 링크를 다시 열어 주세요.' : '새로고침한 뒤 다시 확인해 주세요.'}
      extra={onClose ? <Button onClick={onClose}>로그인으로 돌아가기</Button>
        : <Button type="primary" onClick={() => window.location.reload()}>새로고침</Button>} />
  }
}
