import { useEffect, useState } from 'react'
import type { Config } from '@shared/types'
import { api } from './api'
import Launcher from './components/Launcher'
import Settings from './components/Settings'

const isSettingsWindow = window.location.hash.replace(/^#\/?/, '') === 'settings'

export default function App() {
  const [config, setConfig] = useState<Config | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api
      .getConfig()
      .then((next) => {
        if (alive) setConfig(next)
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      alive = false
    }
  }, [])

  if (error) {
    return (
      <div className="boot">
        <h1>无法读取配置</h1>
        <p>{error}</p>
      </div>
    )
  }

  if (!config) {
    return <div className="boot">正在载入…</div>
  }

  return isSettingsWindow ? <Settings initial={config} /> : <Launcher config={config} onConfig={setConfig} />
}
