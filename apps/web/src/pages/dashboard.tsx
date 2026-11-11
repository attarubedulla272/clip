import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Clapperboard, Plus, Sparkles } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { useCurrentUser } from "../app";
import { apiRequest } from "../lib/api";

interface Project {
  _id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export function DashboardPage() {
  const user = useCurrentUser().data?.user;
  const [name, setName] = useState("");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: () => apiRequest<{ projects: Project[] }>("/projects")
  });
  const createProject = useMutation({
    mutationFn: () => apiRequest<{ project: Project }>("/projects", {
      method: "POST",
      body: JSON.stringify({ name })
    }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      setName("");
      await navigate(`/projects/${result.project._id}`);
    }
  });
  const logout = useMutation({
    mutationFn: () => apiRequest<void>("/auth/logout", { method: "POST", retryAfterRefresh: false }),
    onSuccess: async () => {
      queryClient.clear();
      await navigate("/");
    }
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createProject.mutate();
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <Link to="/" className="brand"><span className="brand-mark"><Clapperboard size={17} /></span>clipforge</Link>
        <div className="header-right"><span>{user?.email}</span><Button variant="ghost" size="small" onClick={() => logout.mutate()}>Sign out</Button></div>
      </header>
      <section className="dashboard-wrap">
        <div className="dashboard-greeting"><div><span className="section-kicker">YOUR WORKSPACE</span><h1>Good work starts<br />with a good moment.</h1><p>Bring in a long video, and we’ll help you find what’s worth sharing.</p></div><div className="sparkle-badge"><Sparkles size={25} /></div></div>
        <div className="projects-heading"><div><h2>Your projects</h2><p>Videos and clips, all in one place.</p></div><span className="local-pill"><span /> STORED LOCALLY</span></div>
        <div className="project-create panel">
          <div className="project-create-icon"><Plus size={19} /></div>
          <div className="project-create-info"><strong>Start a new project</strong><span>Give your video a home to get started.</span></div>
          <form onSubmit={submit} className="project-create-form">
            <input aria-label="Project name" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Studio interview" />
            <Button type="submit" disabled={createProject.isPending}>{createProject.isPending ? "Creating…" : "Create project"} <ArrowRight size={15} /></Button>
          </form>
        </div>
        {createProject.isError && <p className="form-error" role="alert">{createProject.error.message}</p>}
        <div className="project-grid">
          {projectsQuery.isPending && <div className="empty-panel">Loading projects…</div>}
          {projectsQuery.isError && <div className="empty-panel error-state">Couldn’t load projects. {projectsQuery.error.message}</div>}
          {projectsQuery.data?.projects.map((project) => (
            <Link to={`/projects/${project._id}`} className="project-card panel" key={project._id}>
              <span className="project-card-icon"><Clapperboard size={20} /></span>
              <strong>{project.name}</strong>
              <span>Created {new Date(project.createdAt).toLocaleDateString()}</span>
              <ArrowRight size={16} className="project-arrow" />
            </Link>
          ))}
          {!projectsQuery.isPending && !projectsQuery.isError && projectsQuery.data?.projects.length === 0 && (
            <div className="empty-panel"><div className="empty-icon"><Clapperboard size={22} /></div><strong>No projects yet</strong><span>Create your first project above to start shaping clips.</span></div>
          )}
        </div>
      </section>
    </main>
  );
}
