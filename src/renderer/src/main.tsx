import { createRoot } from 'react-dom/client'
import { App, getWindowMode } from './App'
import './styles.css'

const mode = getWindowMode()
document.documentElement.dataset.window = mode
document.body.dataset.window = mode

const root = document.getElementById('root')
if (!root) throw new Error('QPet renderer root is missing.')

createRoot(root).render(<App />)
