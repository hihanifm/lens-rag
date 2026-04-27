import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Home from './pages/Home'
import CreateProject from './pages/CreateProject'
import Search from './pages/Search'
import EvaluateProject from './pages/EvaluateProject'
import History from './pages/History'
import Settings from './pages/Settings'
import Browse from './pages/Browse'
import Layout from './components/Layout'

const queryClient = new QueryClient()

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/projects/new" element={<CreateProject />} />
            <Route path="/projects/:projectId/search" element={<Search />} />
            <Route path="/projects/:projectId/evaluate" element={<EvaluateProject />} />
            <Route path="/projects/:projectId/settings" element={<Settings />} />
            <Route path="/projects/:projectId/browse" element={<Browse />} />
            <Route path="/history" element={<History />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
