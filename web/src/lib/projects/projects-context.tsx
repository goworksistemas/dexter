/**
 * Estado de projetos: lista, projeto ativo, CRUD e sync com URL `/p/:projectId`.
 */
import * as React from "react"
import { useLocation, useNavigate } from "react-router-dom"

import { useAuth } from "@/providers/auth-provider"
import {
  createProject as createProjectApi,
  deleteProject as deleteProjectApi,
  fetchProjects,
  updateProject as updateProjectApi,
} from "./api"
import type {
  CreateProjectInput,
  ProjectSummary,
  UpdateProjectInput,
} from "./types"

interface ProjectsContextValue {
  projects: ProjectSummary[]
  isLoadingProjects: boolean
  projectsError: string | null
  activeProjectId: string | null
  activeProject: ProjectSummary | undefined
  selectProject: (id: string | null) => void
  createProject: (input: CreateProjectInput) => Promise<ProjectSummary>
  updateProject: (
    id: string,
    input: UpdateProjectInput,
  ) => Promise<ProjectSummary>
  deleteProject: (id: string) => Promise<void>
  refreshProjects: () => void
}

const ProjectsContext = React.createContext<ProjectsContextValue | null>(null)

function projectIdFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/p\/([^/]+)/)
  return m?.[1] ?? null
}

export function ProjectsProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [projects, setProjects] = React.useState<ProjectSummary[]>([])
  const [isLoadingProjects, setIsLoadingProjects] = React.useState(true)
  const [projectsError, setProjectsError] = React.useState<string | null>(null)
  const [activeProjectId, setActiveProjectId] = React.useState<string | null>(
    () =>
      typeof window !== "undefined"
        ? projectIdFromPath(window.location.pathname)
        : null,
  )
  const skipUrlSyncRef = React.useRef(false)

  const refreshProjects = React.useCallback(() => {
    if (!isAuthenticated) {
      setProjects([])
      setProjectsError(null)
      setIsLoadingProjects(false)
      return
    }
    setIsLoadingProjects(true)
    setProjectsError(null)
    fetchProjects()
      .then((lista) => setProjects(lista))
      .catch((err) => {
        setProjectsError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setIsLoadingProjects(false))
  }, [isAuthenticated])

  React.useEffect(() => {
    if (isAuthLoading) return
    refreshProjects()
  }, [isAuthLoading, refreshProjects])

  // URL → estado
  React.useEffect(() => {
    if (skipUrlSyncRef.current) {
      skipUrlSyncRef.current = false
      return
    }
    const fromUrl = projectIdFromPath(location.pathname)
    setActiveProjectId(fromUrl)
  }, [location.pathname])

  const selectProject = React.useCallback(
    (id: string | null) => {
      setActiveProjectId(id)
      skipUrlSyncRef.current = true
      if (id) {
        const target = `/p/${id}`
        if (location.pathname !== target) {
          navigate(target, { replace: false })
        }
      } else if (location.pathname.startsWith("/p/")) {
        navigate("/", { replace: false })
      }
    },
    [navigate, location.pathname],
  )

  const createProject = React.useCallback(
    async (input: CreateProjectInput) => {
      const created = await createProjectApi(input)
      setProjects((prev) =>
        [created, ...prev].sort((a, b) =>
          a.updated_at < b.updated_at ? 1 : -1,
        ),
      )
      return created
    },
    [],
  )

  const updateProject = React.useCallback(
    async (id: string, input: UpdateProjectInput) => {
      const updated = await updateProjectApi(id, input)
      setProjects((prev) =>
        prev
          .map((p) => (p.id === id ? updated : p))
          .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)),
      )
      return updated
    },
    [],
  )

  const deleteProjectFn = React.useCallback(
    async (id: string) => {
      await deleteProjectApi(id)
      setProjects((prev) => prev.filter((p) => p.id !== id))
      if (activeProjectId === id) {
        selectProject(null)
      }
    },
    [activeProjectId, selectProject],
  )

  const activeProject = projects.find((p) => p.id === activeProjectId)

  const value = React.useMemo<ProjectsContextValue>(
    () => ({
      projects,
      isLoadingProjects,
      projectsError,
      activeProjectId,
      activeProject,
      selectProject,
      createProject,
      updateProject,
      deleteProject: deleteProjectFn,
      refreshProjects,
    }),
    [
      projects,
      isLoadingProjects,
      projectsError,
      activeProjectId,
      activeProject,
      selectProject,
      createProject,
      updateProject,
      deleteProjectFn,
      refreshProjects,
    ],
  )

  return (
    <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>
  )
}

export function useProjects(): ProjectsContextValue {
  const ctx = React.useContext(ProjectsContext)
  if (!ctx) {
    throw new Error("useProjects deve ser usado dentro de <ProjectsProvider>")
  }
  return ctx
}
