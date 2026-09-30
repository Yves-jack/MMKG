import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import { QaFloatingAssistant } from "@/components/apps/QaFloatingAssistant";
import { AssetsPage } from "@/pages/AssetsPage";
import { CourseHub } from "@/pages/CourseHub";
import { Home } from "@/pages/Home";
import { PipelinePage } from "@/pages/PipelinePage";
import { KgPage } from "@/pages/KgPage";
import { MindmapPage } from "@/pages/MindmapPage";
import { ReviewPage } from "@/pages/ReviewPage";
import { TextbookPage } from "@/pages/TextbookPage";
import { PracticePage } from "@/pages/apps/PracticePage";
import { AnimatePage } from "@/pages/apps/AnimatePage";
import { ResourcesPage } from "@/pages/apps/ResourcesPage";
import { encodeCourseId } from "@/lib/course";

const DEFAULT_COURSE = "离散数学(图论+数理逻辑与集合论)";

function LegacyRedirect({ to }: { to: string }) {
  const params = useParams();
  let path = to;
  for (const [k, v] of Object.entries(params)) {
    if (v != null) path = path.replace(`:${k}`, String(v));
  }
  return <Navigate to={`/course/${encodeCourseId(DEFAULT_COURSE)}${path}`} replace />;
}

const routerBasename = (import.meta.env.BASE_URL || "/").replace(/\/$/, "") || undefined;

export default function App() {
  return (
    <BrowserRouter basename={routerBasename}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/course/:courseId" element={<CourseHub />} />
        <Route path="/course/:courseId/mindmap" element={<MindmapPage />} />
        <Route path="/course/:courseId/textbook" element={<TextbookPage />} />
        <Route
          path="/course/:courseId/pipeline"
          element={<Navigate to="1" relative="path" replace />}
        />
        <Route path="/course/:courseId/pipeline/:lectureId" element={<PipelinePage />} />
        <Route
          path="/course/:courseId/assets"
          element={<Navigate to="1" relative="path" replace />}
        />
        <Route path="/course/:courseId/assets/:lectureId" element={<AssetsPage />} />
        <Route path="/course/:courseId/apps/review/:lectureId" element={<ReviewPage />} />
        <Route path="/course/:courseId/apps/practice" element={<PracticePage />} />
        <Route path="/course/:courseId/apps/animate" element={<AnimatePage />} />
        <Route path="/course/:courseId/apps/resources" element={<ResourcesPage />} />
        <Route
          path="/course/:courseId/kg"
          element={<Navigate to="session/1_2" relative="path" replace />}
        />
        <Route path="/course/:courseId/kg/course" element={<KgPage />} />
        <Route path="/course/:courseId/kg/lecture/:lectureId" element={<KgPage />} />
        <Route path="/course/:courseId/kg/session/:sessionId" element={<KgPage />} />
        <Route path="/mindmap" element={<LegacyRedirect to="/mindmap" />} />
        <Route path="/textbook" element={<LegacyRedirect to="/textbook" />} />
        <Route path="/textbook/text" element={<LegacyRedirect to="/textbook" />} />
        <Route path="/pipeline" element={<LegacyRedirect to="/pipeline/1" />} />
        <Route path="/pipeline/:lectureId" element={<LegacyRedirect to="/pipeline/:lectureId" />} />
        <Route path="/assets" element={<LegacyRedirect to="/assets/1" />} />
        <Route path="/assets/:lectureId" element={<LegacyRedirect to="/assets/:lectureId" />} />
        <Route path="/apps/review" element={<LegacyRedirect to="/apps/review/1" />} />
        <Route
          path="/apps/review/:lectureId"
          element={<LegacyRedirect to="/apps/review/:lectureId" />}
        />
        <Route path="/apps/qa" element={<LegacyRedirect to="/apps/review/1" />} />
        <Route path="/apps/practice" element={<LegacyRedirect to="/apps/practice" />} />
        <Route path="/apps/outline" element={<LegacyRedirect to="/apps/review/1" />} />
        <Route path="/apps/animate" element={<LegacyRedirect to="/apps/animate" />} />
        <Route path="/apps/resources" element={<LegacyRedirect to="/apps/resources" />} />
        <Route path="/apps/digest" element={<LegacyRedirect to="/apps/review/1" />} />
        <Route path="/kg" element={<LegacyRedirect to="/kg/session/1_2" />} />
        <Route path="/kg/course" element={<LegacyRedirect to="/kg/course" />} />
        <Route
          path="/kg/lecture/:lectureId"
          element={<LegacyRedirect to="/kg/lecture/:lectureId" />}
        />
        <Route
          path="/kg/session/:sessionId"
          element={<LegacyRedirect to="/kg/session/:sessionId" />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <QaFloatingAssistant />
    </BrowserRouter>
  );
}

