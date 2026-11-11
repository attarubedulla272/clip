import { ArrowDown, ArrowRight, Clapperboard, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "../components/ui/button";

export function LandingPage() {
  return (
    <main className="landing-page">
      <header className="site-header">
        <Link to="/" className="brand"><span className="brand-mark"><Clapperboard size={18} /></span>clipforge</Link>
        <nav><Link to="/login" className="nav-link">Sign in</Link><Button asChild size="small"><Link to="/register">Get started <ArrowRight size={15} /></Link></Button></nav>
      </header>
      <section className="hero">
        <div className="eyebrow"><Sparkles size={14} /> YOUR LOCAL-FIRST CLIP STUDIO</div>
        <h1>Make the moments<br /><span>that make people stop.</span></h1>
        <p>Find the sharpest ideas in your long videos, shape them into short clips, and keep the whole creative process on your own machine.</p>
        <div className="hero-actions"><Button asChild><Link to="/register">Start creating <ArrowRight size={16} /></Link></Button><a className="text-link" href="#how">See how it works <ArrowDown size={15} /></a></div>
        <div className="hero-preview">
          <div className="preview-top"><div className="window-dots"><i /><i /><i /></div><span>clipforge / product preview</span><span className="local-pill"><span /> LOCAL & PRIVATE</span></div>
          <div className="preview-body">
            <div className="preview-rail"><b className="rail-logo">c.</b><div className="rail-active" /><div /><div /></div>
            <div className="preview-content"><div className="preview-heading"><div><small>YOUR CREATOR WORKSPACE</small><h3>Your next great clip<br />starts here.</h3></div><div className="avatar">CF</div></div><div className="preview-cards"><div className="preview-card"><span className="card-icon violet"><Clapperboard size={17} /></span><small>PROJECTS</small><strong>—</strong><span>ready to shape</span></div><div className="preview-card"><span className="card-icon mint"><Sparkles size={17} /></span><small>CLIPS FOUND</small><strong>—</strong><span>across your videos</span></div><div className="preview-card preview-upload"><div className="upload-orbit"><ArrowDown size={18} /></div><strong>Drop a video to begin</strong><span>MP4, MOV, MKV or WebM</span></div></div><div className="preview-timeline"><div className="timeline-title"><span>EXAMPLE TIMELINE</span><small>Illustrative preview</small></div><div className="timeline-track"><i /><i /><i /><i /><i /><i /><i /><i /><b>00:00</b></div></div></div>
          </div>
        </div>
      </section>
      <section className="how-section" id="how">
        <div><span className="section-kicker">A BETTER KIND OF WORKFLOW</span><h2>From long-form to<br />ready-to-share.</h2></div>
        <div className="steps"><article><b>01</b><h3>Bring your video</h3><p>Upload content you own. Your media stays in your local ClipForge workspace.</p></article><article><b>02</b><h3>Find the good parts</h3><p>Review transcript highlights and clip recommendations with clear score breakdowns.</p></article><article><b>03</b><h3>Make it yours</h3><p>Trim, style captions, and export vertical clips when you’re happy with them.</p></article></div>
      </section>
      <footer><Link to="/" className="brand"><span className="brand-mark"><Clapperboard size={15} /></span>clipforge</Link><span>Local-first video creation. Scores are guidance, never guarantees.</span></footer>
    </main>
  );
}
