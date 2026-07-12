import { NavLink, Outlet } from 'react-router-dom'
import { BetaBanner } from './components/BetaBanner'

export function App() {
  return (
    <div className="app">
      <BetaBanner />
      {import.meta.env.DEV && (
        <nav className="bar">
          <div className="bar__nav">
            <NavLink to="/" end className={({ isActive }) => `bar__link${isActive ? ' active' : ''}`}>
              <span className="lamp" />
              <span className="bar__index">01</span> Generate
            </NavLink>
            <NavLink to="/tag" className={({ isActive }) => `bar__link${isActive ? ' active' : ''}`}>
              <span className="lamp" />
              <span className="bar__index">02</span> Library
            </NavLink>
          </div>
        </nav>
      )}
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}
