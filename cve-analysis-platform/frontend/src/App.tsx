import { Route, Routes, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import NewRun from "./pages/NewRun";
import RunDetail from "./pages/RunDetail";
import CVEDetail from "./pages/CVEDetail";
import IndexPage from "./pages/IndexPage";
import JenkinsPage from "./pages/JenkinsPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="runs/new" element={<NewRun />} />
        <Route path="runs/:runId" element={<RunDetail />} />
        <Route path="runs/:runId/cves/:cveId" element={<CVEDetail />} />
        <Route path="index" element={<IndexPage />} />
        <Route path="jenkins" element={<JenkinsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
