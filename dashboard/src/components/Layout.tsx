import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";

export default function Layout() {
  return (
    <div className="flex h-full w-full bg-surface-0 text-ink">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-[1400px] px-8 py-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
