import { useEffect, useState } from "react";
import { fetchJobs, type Job } from "../lib/api";

export function JobsList() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { jobs } = await fetchJobs();
        if (!cancelled) setJobs(jobs);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      }
    }
    load();
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="jobs-list">
      <div className="jobs-head">
        <h2>Jobs</h2>
        {error && <span className="error">{error}</span>}
      </div>
      {jobs.length === 0 ? (
        <p className="muted">No jobs yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Name</th>
              <th>Created</th>
              <th>ID</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td className={`status status-${j.status}`}>{j.status}</td>
                <td>
                  <a href={`#/jobs/${j.id}`}>{j.name}</a>
                </td>
                <td>{new Date(j.createdAt).toLocaleString()}</td>
                <td>
                  <code>{j.id}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
