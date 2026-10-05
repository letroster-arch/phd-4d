import { lazy, Suspense } from 'react';
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, Navigate, useLocation } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import ScrollToTop from './components/ScrollToTop';
import ProtectedRoute from '@/components/ProtectedRoute';
import Login from '@/pages/Login';
import Register from '@/pages/Register';
import ForgotPassword from '@/pages/ForgotPassword';
import ResetPassword from '@/pages/ResetPassword';
import AppLayout from '@/components/phd/AppLayout';
import '@/components/phd/bundle-projects.css';
import '@/components/phd/bundle-live.css';

const DigitalTwin = lazy(() => import('@/pages/DigitalTwin'));
const Settings = lazy(() => import('@/pages/Settings'));
const DataCenter = lazy(() => import('@/pages/DataCenter'));
const Executive = lazy(() => import('@/pages/Executive'));
const Links4D = lazy(() => import('@/pages/Links4D'));
const Simulation4D = lazy(() => import('@/pages/Simulation4D'));
const Awp = lazy(() => import('@/pages/Awp'));
const ProjectControl = lazy(() => import('@/pages/ProjectControl'));
const Quality = lazy(() => import('@/pages/Quality'));
const PhdAI = lazy(() => import('@/pages/PhdAI'));
const Projects = lazy(() => import('@/pages/Projects'));

function WorkspaceLoader(){
  return <div className="studio-route-loader" role="status" aria-live="polite">
    <span className="studio-route-loader-mark"/>
    <strong>PHD 360 4D</strong>
    <small>CARREGANDO WORKSPACE</small>
  </div>;
}

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError } = useAuth();
  const { pathname } = useLocation();
  const authRoute = ['/login', '/register', '/forgot-password', '/reset-password'].includes(pathname);

  if (isLoadingPublicSettings || isLoadingAuth) {
    return <WorkspaceLoader />;
  }

  if (authError) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    } else if (authError.type === 'auth_required' && !authRoute) {
      return <Navigate to={'/login?returnTo=' + encodeURIComponent(window.location.pathname + window.location.search)} replace />;
    }
  }

  return (
    <Suspense fallback={<WorkspaceLoader />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route element={<ProtectedRoute unauthenticatedElement={<Navigate to="/login" replace />} />}>
          <Route element={<AppLayout />}>
            <Route path="/" element={<DigitalTwin />} />
            <Route path="/projetos" element={<Projects />} />
            <Route path="/configuracoes" element={<Settings />} />
            <Route path="/central-de-dados" element={<DataCenter />} />
            <Route path="/executivo" element={<Executive />} />
            <Route path="/vinculos-4d" element={<Links4D />} />
            <Route path="/simulacao-4d" element={<Simulation4D />} />
            <Route path="/awp" element={<Awp />} />
            <Route path="/controle-do-projeto" element={<ProjectControl />} />
            <Route path="/qualidade" element={<Quality />} />
            <Route path="/phd-ai" element={<PhdAI />} />
          </Route>
        </Route>
        <Route path="*" element={<PageNotFound />} />
      </Routes>
    </Suspense>
  );
};

function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <ScrollToTop />
          <AuthenticatedApp />
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  )
}

export default App