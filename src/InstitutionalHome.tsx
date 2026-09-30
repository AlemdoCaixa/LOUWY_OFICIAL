import { ArrowRight, CalendarDays, Check, Headphones, Layers3, Music2, Users } from "lucide-react";
import "./InstitutionalHome.css";
import { formatPlanPrice, planMemberLabel, PLANS } from "./plans";

type Props = {
  onAccess: () => void;
  onRegister: () => void;
};

const features = [
  { icon: CalendarDays, title: "Escalas e eventos", text: "Monte cultos, ensaios e reuniões com confirmações e comunicação centralizada." },
  { icon: Music2, title: "Repertório inteligente", text: "Organize músicas, tons, letras, pastas e playlists sem duplicar o catálogo." },
  { icon: Headphones, title: "Preparação musical", text: "Altere tom e velocidade, separe instrumentos e grave vozes sobre o playback." },
  { icon: Users, title: "Equipes com autonomia", text: "Cada igreja tem seu master, e cada equipe pode ter um líder responsável." },
];

export default function InstitutionalHome({ onAccess, onRegister }: Props) {
  return <div className="institutional-page">
    <header className="institutional-header">
      <a className="institutional-brand" href="/" aria-label="Louwy">
        <img className="institutional-logo" src="/branding/louwy-institucional-v2.svg" alt="Louwy"/>
      </a>
      <div className="institutional-header-actions">
        <button className="institutional-link" onClick={onAccess}>Acessar minha igreja</button>
        <button className="institutional-button small" onClick={onRegister}>Cadastrar igreja</button>
      </div>
    </header>
    <main>
      <section className="institutional-hero">
        <div className="institutional-hero-copy">
          <span className="institutional-kicker"><Layers3 size={15}/> Plataforma para ministérios de louvor</span>
          <h1>Todo o ministério afinado, dentro e fora do palco.</h1>
          <p>O Louwy reúne pessoas, escalas, repertórios e preparação musical em um ambiente próprio para cada igreja.</p>
          <div className="institutional-hero-actions">
            <button className="institutional-button" onClick={onRegister}>Cadastrar minha igreja <ArrowRight size={17}/></button>
            <button className="institutional-secondary" onClick={onAccess}>Já tenho uma igreja</button>
          </div>
          <small>Cada igreja recebe um endereço exclusivo, como <strong>primicias.louwy.com.br</strong>.</small>
        </div>
        <div className="institutional-preview" aria-label="Prévia do Louwy">
          <div className="institutional-preview-bar"><span/><span/><span/><b>primicias.louwy.com.br</b></div>
          <div className="institutional-preview-body">
            <aside><img src="/icons/louwy-192.png" alt=""/><i/><i/><i/><i/></aside>
            <div className="institutional-preview-content">
              <div className="preview-greeting"><span>Seu ambiente de louvor</span><strong>Pessoas, eventos e preparação musical no mesmo lugar.</strong></div>
              <div className="preview-stats"><span/><span/><span/></div>
              <div className="preview-event"><CalendarDays size={22}/><div><strong>Próximo culto</strong><span>Domingo · 19h</span></div></div>
            </div>
          </div>
        </div>
      </section>
      <section className="institutional-features">
        <div className="institutional-section-heading">
          <span>Uma única plataforma</span>
          <h2>Menos mensagens perdidas. Mais gente preparada.</h2>
        </div>
        <div className="institutional-feature-grid">
          {features.map(({ icon: Icon, title, text }) => <article key={title}>
            <div><Icon size={20}/></div><h3>{title}</h3><p>{text}</p>
          </article>)}
        </div>
      </section>

      <section className="institutional-pricing" id="planos">
        <div className="institutional-section-heading">
          <span>Planos simples</span>
          <h2>Comece grátis. Cresça só quando a equipe crescer.</h2>
          <p>O plano grátis aceita até 5 contas ativas, incluindo a conta master.</p>
        </div>
        <div className="institutional-plan-grid">
          {PLANS.map((plan)=><article className={`institutional-plan-card ${plan.id==="members25"?"featured":""}`} key={plan.id}>
            <div className="institutional-plan-top"><span>{plan.name}</span>{plan.id==="members25"&&<b>Melhor custo por membro</b>}</div>
            <div className="institutional-plan-price"><strong>{formatPlanPrice(plan.priceCents)}</strong>{plan.priceCents>0&&<small>/mês</small>}</div>
            <p>{planMemberLabel(plan.memberLimit)}</p>
            <ul><li><Check size={15}/> Todos os recursos do Louwy</li><li><Check size={15}/> Equipes, eventos e repertórios</li><li><Check size={15}/> App com identidade da igreja</li></ul>
            <button className={plan.id==="free"?"institutional-secondary":"institutional-button"} onClick={onRegister}>{plan.id==="free"?"Começar grátis":"Cadastrar minha igreja"}</button>
          </article>)}
        </div>
      </section>

      <section className="institutional-final-cta">
        <div><span>Comece com sua própria identidade</span><h2>Sua igreja, sua logo, suas equipes e seu endereço.</h2></div>
        <button className="institutional-button" onClick={onRegister}>Criar ambiente da igreja <ArrowRight size={17}/></button>
      </section>
    </main>
    <footer className="institutional-footer"><img src="/branding/louwy-institucional-v2.svg" alt="Louwy"/><span>Plataforma para ministérios de louvor.</span></footer>
  </div>;
}
