import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Home } from "@/pages/Home";
import { PipelinePage } from "@/pages/PipelinePage";
import { KgPage } from "@/pages/KgPage";
import { ImportancePage } from "@/pages/ImportancePage";
import { MindmapPage } from "@/pages/MindmapPage";
import { TextbookPage } from "@/pages/TextbookPage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/importance" element={<ImportancePage />} />
        <Route path="/mindmap" element={<MindmapPage />} />
        <Route path="/textbook" element={<TextbookPage />} />
        <Route path="/textbook/text" element={<Navigate to="/textbook" replace />} />
        <Route path="/pipeline" element={<Navigate to="/pipeline/1" replace />} />
        <Route path="/pipeline/:lectureId" element={<PipelinePage />} />
        <Route path="/kg" element={<Navigate to="/kg/lecture/1" replace />} />
        <Route path="/kg/course" element={<KgPage />} />
        <Route path="/kg/lecture/:lectureId" element={<KgPage />} />
        <Route path="/kg/session/:sessionId" element={<KgPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
