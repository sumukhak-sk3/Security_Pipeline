import { NavLink, Outlet } from "react-router-dom";
import ThemeToggle from "./ThemeToggle";

export default function Layout() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>CVE Analysis Platform</h1>
        <nav className="app-nav">
          <NavLink to="/" end>
            Runs
          </NavLink>
          <NavLink to="/runs/new">New Run</NavLink>
          <NavLink to="/index">Code Index</NavLink>
          <NavLink to="/jenkins">Jenkins</NavLink>
        </nav>
        <ThemeToggle />
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
