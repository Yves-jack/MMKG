import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useParams, useSearchParams } from "react-router-dom";
import { AssetsPage } from "@/pages/AssetsPage";
import { CourseHub } from "@/pages/CourseHub";
import { Home } from "@/pages/Home";
import { KgPage } from "@/pages/KgPage";
import { MindmapPage } from "@/pages/MindmapPage";
import { ReviewPage } from "@/pages/ReviewPage";
import { encodeCourseId } from "@/lib/course";
import { applyEmbedTheme } from "@/styles/embedTheme";

const DEFAULT_COURSE = "离散数学(图论+数理逻辑与集合论)";

function EmbedThemeSync() {
  const [searchParams] = useSearchParams();
  useEffect(() => {
    applyEmbedTheme(String(searchParams.get("embed") || ""));
  }, [searchParams]);
  return null;
}

function LegacyRedirect({ to }: { to: string }) {
  const params = useParams();
  let path = to;
  for (const [k, v] of Object.entries(params)) {
    if (v != null) path = path.replace(`:${k}`, String(v));
  }
  return <Navigate to={`/course/${encodeCourseId(DEFAULT_COURSE)}${path}`} replace />;
}

function HubRedirect() {
  const { courseId } = useParams();
  if (!courseId) {
    return <Navigate to={`/course/${encodeCourseId(DEFAULT_COURSE)}`} replace />;
  }
  return <Navigate to={`/course/${courseId}`} replace />;
}

function LegacyHubRedirect() {
  return <Navigate to={`/course/${encodeCourseId(DEFAULT_COURSE)}`} replace />;
}

const routerBasename = (import.meta.env.BASE_URL || "/").replace(/\/$/, "") || undefined;

export default function App() {
  return (
    <BrowserRouter basename={routerBasename}>
      <EmbedThemeSync />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/course/:courseId" element={<CourseHub />} />
        <Route path="/course/:courseId/mindmap" element={<MindmapPage />} />
        <Route
          path="/course/:courseId/assets"
          element={<Navigate to="1" relative="path" replace />}
        />
        <Route path="/course/:courseId/assets/:lectureId" element={<AssetsPage />} />
        <Route path="/course/:courseId/apps/review/:lectureId" element={<ReviewPage />} />
        <Route
          path="/course/:courseId/kg"
          element={<Navigate to="course" relative="path" replace />}
        />
        <Route path="/course/:courseId/kg/course" element={<KgPage />} />
        <Route path="/course/:courseId/kg/lecture/:lectureId" element={<KgPage />} />
        <Route path="/course/:courseId/kg/session/:sessionId" element={<KgPage />} />

        {/* 已移除功能 → 课门户 */}
        <Route path="/course/:courseId/textbook" element={<HubRedirect />} />
        <Route path="/course/:courseId/pipeline" element={<HubRedirect />} />
        <Route path="/course/:courseId/pipeline/:lectureId" element={<HubRedirect />} />
        <Route path="/course/:courseId/apps/practice" element={<HubRedirect />} />
        <Route path="/course/:courseId/apps/animate" element={<HubRedirect />} />
        <Route path="/course/:courseId/apps/resources" element={<HubRedirect />} />

        <Route path="/mindmap" element={<LegacyRedirect to="/mindmap" />} />
        <Route path="/assets" element={<LegacyRedirect to="/assets/1" />} />
        <Route path="/assets/:lectureId" element={<LegacyRedirect to="/assets/:lectureId" />} />
        <Route path="/apps/review" element={<LegacyRedirect to="/apps/review/1" />} />
        <Route
          path="/apps/review/:lectureId"
          element={<LegacyRedirect to="/apps/review/:lectureId" />}
        />
        <Route path="/kg" element={<LegacyRedirect to="/kg/course" />} />
        <Route path="/kg/course" element={<LegacyRedirect to="/kg/course" />} />
        <Route
          path="/kg/lecture/:lectureId"
          element={<LegacyRedirect to="/kg/lecture/:lectureId" />}
        />
        <Route
          path="/kg/session/:sessionId"
          element={<LegacyRedirect to="/kg/session/:sessionId" />}
        />

        <Route path="/textbook" element={<LegacyHubRedirect />} />
        <Route path="/textbook/text" element={<LegacyHubRedirect />} />
        <Route path="/pipeline" element={<LegacyHubRedirect />} />
        <Route path="/pipeline/:lectureId" element={<LegacyHubRedirect />} />
        <Route path="/apps/qa" element={<LegacyHubRedirect />} />
        <Route path="/apps/practice" element={<LegacyHubRedirect />} />
        <Route path="/apps/outline" element={<LegacyHubRedirect />} />
        <Route path="/apps/animate" element={<LegacyHubRedirect />} />
        <Route path="/apps/resources" element={<LegacyHubRedirect />} />
        <Route path="/apps/digest" element={<LegacyHubRedirect />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
