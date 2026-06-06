import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import Overview from "./pages/Overview";
import WorkflowPage from "./pages/WorkflowPage";
import CICDPage from "./pages/CICDPage";
import History from "./pages/History";
import Metrics from "./pages/Metrics";
import RunDetail from "./pages/RunDetail";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="/workflows/:id" element={<WorkflowPage />} />
        <Route path="/cicd" element={<CICDPage />} />
        <Route path="/history" element={<History />} />
        <Route path="/history/:runId" element={<RunDetail />} />
        <Route path="/metrics" element={<Metrics />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
