import React from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'

function App(): React.JSX.Element {
  return (
    <main>
      <header>
        <span className="brand">ADE</span>
        <span className="status">Desktop foundation</span>
      </header>
      <section className="welcome">
        <p className="eyebrow">Your development environment</p>
        <h1>Work across agents, in one place.</h1>
        <p>The new desktop shell is ready. Profile and runtime connection comes next.</p>
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
