import { App as AntApp, ConfigProvider, Empty } from 'antd'
import { theme } from 'antd'
import AdminLogin from './AdminLogin'
import koKR from 'antd/locale/ko_KR'
import './tokens.css'

export default function App() {
  return (
    <ConfigProvider
      locale={koKR}
      form={{ scrollToFirstError: { focus: true } }}
      renderEmpty={(component) => component === 'Table' ? <Empty description="조건에 맞는 항목이 없어요." /> : undefined}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#C8FF00',
          colorTextLightSolid: '#000000',
          colorBgBase: '#0F1112',
          colorBgContainer: '#171A13',
          colorBgElevated: '#1D2116',
          colorBorder: '#3C3D41',
          colorError: '#C13515',
          fontFamily: 'Pretendard, system-ui, sans-serif',
          lineHeight: 1.4,
        },
      }}
    >
      <AntApp>
        <AdminLogin />
      </AntApp>
    </ConfigProvider>
  )
}
