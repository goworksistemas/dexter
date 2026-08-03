export { ProjectsProvider, useProjects } from "./projects-context"
export {
  createProject,
  deleteProject,
  deleteProjectFile,
  fetchProject,
  fetchProjectFiles,
  fetchProjects,
  fileToBase64,
  updateProject,
  uploadProjectFile,
} from "./api"
export type {
  CreateProjectInput,
  ProjectFileRecord,
  ProjectSummary,
  UpdateProjectInput,
} from "./types"
export { PROJECT_COLORS } from "./types"
