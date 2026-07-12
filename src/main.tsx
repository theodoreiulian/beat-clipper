import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import { App } from './App'
import { GeneratorPage } from './pages/GeneratorPage'
import '@fontsource-variable/archivo/wdth.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './styles.css'

// Dev-only: the tagging tool never ships in the public build. The dynamic
// import sits in dead code when import.meta.env.DEV is false, so Rollup
// emits no TagPage chunk at all.
const TagPage = import.meta.env.DEV
  ? lazy(() => import('./pages/TagPage').then((m) => ({ default: m.TagPage })))
  : null

// Hash routing keeps deep links working on any static host without rewrites.
const router = createHashRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <GeneratorPage /> },
      ...(import.meta.env.DEV && TagPage
        ? [
            {
              path: 'tag',
              element: (
                <Suspense fallback={null}>
                  <TagPage />
                </Suspense>
              ),
            },
          ]
        : []),
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
