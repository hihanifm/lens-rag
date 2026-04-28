import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Home from './pages/Home'
import CreateProject from './pages/CreateProject'
import Search from './pages/Search'
import EvaluateProject from './pages/EvaluateProject'
import History from './pages/History'
import Settings from './pages/Settings'
import Browse from './pages/Browse'
import Cluster from './pages/Cluster'
import SystemConfig from './pages/SystemConfig'
import System from './pages/System'
import Layout from './components/Layout'
import { ProjectStateProvider } from './contexts/ProjectStateContext'

const queryClient = new QueryClient()

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ProjectStateProvider>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <Layout>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/projects/new" element={<CreateProject />} />
            <Route path="/projects/:projectId/search" element={<Search />} />
            <Route path="/projects/:projectId/evaluate" element={<EvaluateProject />} />
            <Route path="/projects/:projectId/settings" element={<Settings />} />
            <Route path="/projects/:projectId/browse" element={<Browse />} />
            <Route path="/projects/:projectId/cluster" element={<Cluster />} />
            <Route path="/projects/:projectId/system" element={<SystemConfig />} />
            <Route path="/system" element={<System />} />
            <Route path="/history" element={<History />} />
          </Routes>
        </Layout>
      </BrowserRouter>
      </ProjectStateProvider>
    </QueryClientProvider>
  )
}
