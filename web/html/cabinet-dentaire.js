import { pariteSemaine } from '../js/planning/clock.js';

const scene = document.getElementById('scene');

function resizeScene() {
  const wrap = document.getElementById('scene-wrap');
  if (!wrap.clientWidth || !wrap.clientHeight) return;
  const scale = Math.min(wrap.clientWidth / 1000, wrap.clientHeight / 1000) * 0.95;
  scene.style.transform = `scale(${scale})`;
}
window.addEventListener('resize', resizeScene);
if (window.ResizeObserver) {
  new ResizeObserver(resizeScene).observe(document.getElementById('scene-wrap'));
}
resizeScene();

const W = 1000, H = 1000;
const px = (x)=> (x/W*100)+'%';
const py = (y)=> (y/H*100)+'%';

function el(cls, html=''){
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = html;
  scene.appendChild(d);
  return d;
}
function setPos(p, x, y){ p.style.left = px(x); p.style.top = py(y); p._x=x; p._y=y; }

/* ---------- Coordinates ---------- */
const RECEPTION_SPOT = {x: 475, y: 485};
const SECRETARY_SPOT = {x: 440, y: 390};
const SECRETARY_SPOT_2 = {x: 510, y: 390};
const QUEUE_SPOTS = [ {x: 475, y: 525}, {x: 515, y: 525}, {x: 555, y: 525} ];

const ENTRANCE = {x: 330, y: 920}; // Patients enter from "Dégagement / entrée arrière" door
const DOOR_IN  = {x: 330, y: 660}; // Corrdior just before Accueil

const WAIT_CHAIRS = [
  {x: 100, y: 480}, {x: 150, y: 480}, {x: 200, y: 480},
  {x: 100, y: 540}, {x: 150, y: 540}, {x: 200, y: 540}
].map(p=>({...p, taken:false}));
const WAIT_STAND_SPOT = {x: 240, y: 500};

// Define real rooms based on the SVG coordinates
const allRooms = [];
allRooms.push({
  id: "Cabinet 5",
  busy: false, occupant: null,
  chair: {x: 180, y: 180},
  dentistHome: {x: 150, y: 150},
  dentistWork: {x: 180, y: 150},
  assistHome: {x: 210, y: 150},
  assistWork: {x: 210, y: 180},
  door: {x: 330, y: 295},
  inside: {x: 280, y: 295},
  pathFromWait: [{x: 310, y: 490}, {x: 310, y: 350}]
});
allRooms.push({
  id: "Cabinet 1",
  busy: false, occupant: null,
  chair: {x: 835, y: 200},
  dentistHome: {x: 800, y: 170},
  dentistWork: {x: 835, y: 170},
  assistHome: {x: 870, y: 170},
  assistWork: {x: 870, y: 200},
  door: {x: 700, y: 330},
  inside: {x: 750, y: 330},
  pathFromWait: [{x: 310, y: 490}, {x: 310, y: 350}, {x: 650, y: 350}]
});
allRooms.push({
  id: "Salle de chirurgie",
  busy: false, occupant: null,
  chair: {x: 833, y: 500},
  dentistHome: {x: 800, y: 470},
  dentistWork: {x: 833, y: 470},
  assistHome: {x: 860, y: 470},
  assistWork: {x: 860, y: 500},
  door: {x: 620, y: 540},
  inside: {x: 730, y: 540},
  pathFromWait: [{x: 310, y: 490}, {x: 550, y: 490}]
});
allRooms.push({
  id: "Cabinet 2",
  busy: false, occupant: null,
  chair: {x: 805, y: 830},
  dentistHome: {x: 770, y: 800},
  dentistWork: {x: 805, y: 800},
  assistHome: {x: 840, y: 800},
  assistWork: {x: 840, y: 830},
  door: {x: 670, y: 690},
  inside: {x: 730, y: 730},
  pathFromWait: [{x: 310, y: 490}, {x: 550, y: 490}, {x: 550, y: 640}]
});
allRooms.push({
  id: "Cabinet 4",
  busy: false, occupant: null,
  chair: {x: 500, y: 800},
  dentistHome: {x: 470, y: 770},
  dentistWork: {x: 500, y: 770},
  assistHome: {x: 530, y: 770},
  assistWork: {x: 530, y: 800},
  door: {x: 390, y: 620},
  inside: {x: 450, y: 680},
  pathFromWait: [{x: 310, y: 490}, {x: 310, y: 640}]
});

const steCoords = { x: 452, y: 200 };

/* ---------- people factory ---------- */
const SKINS = ['#ffd9b3','#f1c27d','#c68642','#8d5524','#ffe0bd'];
const HAIRS = ['#5c4033','#2b2b2b','#c94f2e','#e0b13e','#7d7d7d','#4a2c8f'];
const SUITS = ['#74c0fc','#ffa8a8','#8ce99a','#ffd43b','#e599f7','#63e6be','#ffc078'];
const NAMES = ['Léa','Tom','Nina','Hugo','Emma','Sami','Inès','Noah','Lila','Malo','Zoé','Adam'];
const pick = a => a[Math.floor(Math.random()*a.length)];

function makePerson({suit, skin, hair, badge='', name=''}){
  const p = el('person idle');
  p.style.setProperty('--suit', suit);
  p.style.setProperty('--skin', skin);
  p.style.setProperty('--hair', hair);
  p.innerHTML = `
    <div class="body"></div>
    <div class="head"></div>
    <div class="hair"></div>
    <div class="eye l"></div><div class="eye r"></div>
    <div class="mouth"></div>`;
  // Badge et nom en texte : les noms viennent du planning saisi par l'équipe,
  // jamais interprétés comme du HTML.
  for (const [cls, texte] of [['badge', badge], ['name', name]]) {
    if (!texte) continue;
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = texte;
    p.appendChild(d);
  }
  return p;
}

function bubble(p, txt, ms=1600){
  const b = document.createElement('div');
  b.className='bubble'; b.textContent=txt;
  p.appendChild(b);
  setTimeout(()=>b.remove(), ms);
}
function sparkleAt(x, y){
  const s = el('sparkle');
  s.textContent = pick(['✨','⭐','💫','🦷']);
  s.style.left = px(x + (Math.random()*40-20));
  s.style.top  = py(y + (Math.random()*20-10));
  s.style.setProperty('--dx', (Math.random()*30-15)+'px');
  s.style.setProperty('--dy', (-15-Math.random()*20)+'px');
  setTimeout(()=>s.remove(), 1000);
}

/* ---------- staff (synced with planning) ---------- */
const secretaries = [
  makePerson({suit:'#f76707', skin:pick(SKINS), hair:'#6f4518', badge:'📎', name:'S1 · Secrétaire'}),
  makePerson({suit:'#f76707', skin:pick(SKINS), hair:'#4a2c8f', badge:'📎', name:'S2 · Secrétaire'})
];
setPos(secretaries[0], SECRETARY_SPOT.x, SECRETARY_SPOT.y);
setPos(secretaries[1], SECRETARY_SPOT_2.x, SECRETARY_SPOT_2.y);

let staff = []; // {dentist, assistant}
let standaloneStaff = [];
let activeRooms = [];

/** Jour dont on montre l'équipe : aujourd'hui, ou le lundi suivant un dimanche. */
function jourDuPlanning(maintenant = new Date()) {
  const d = new Date(maintenant);
  d.setHours(12, 0, 0, 0);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return d;
}

const texte = v => (v === null || v === undefined) ? "" : String(v);
const estActif = v => {
  const t = texte(v).trim().toLowerCase();
  return t !== "" && t !== "-" && t !== "repos" && !t.includes("ecole") && !t.includes("école");
};

/** Équipe du jour (matin ou après-midi) lue dans le planning. */
function equipeDuJour(calendarData, maintenant = new Date()) {
  const jour = jourDuPlanning(maintenant);
  const isMorning = maintenant.getDay() === 0 || maintenant.getHours() < 13;
  const alternance = calendarData && calendarData.alternance === "iso" ? "iso" : "continue";
  const parity = pariteSemaine(jour, alternance);
  const daysArr = ["DIMANCHE", "LUNDI", "MARDI", "MERCREDI", "JEUDI", "VENDREDI", "SAMEDI"];
  const currentDayStr = daysArr[jour.getDay()];
  const lignes = calendarData && Array.isArray(calendarData[parity]) ? calendarData[parity] : [];
  const dayData = [];
  for (const row of lignes) {
    if (!row || typeof row !== "object") continue;
    const d = row.days && typeof row.days === "object" ? row.days[currentDayStr] : null;
    if (!d || typeof d !== "object") continue;
    const dentiste = isMorning ? d.am : d.pm;
    if (estActif(dentiste)) dayData.push({ name: texte(dentiste).trim(), assistant: texte(row.assistant).trim() });
  }
  return { dayData, cle: JSON.stringify([parity, currentDayStr, isMorning, dayData]) };
}

async function lirePlanning() {
  try {
    const reponse = await fetch('/api/documents/planning');
    const data = await reponse.json();
    return data && data.valeur;
  } catch (e) {
    return null;
  }
}

let equipeAffichee = null;

async function syncPlanning() {
  // Planning lu en base via le serveur (aucun nom dans le code).
  const { dayData, cle } = equipeDuJour(await lirePlanning());
  equipeAffichee = cle;

  let cabIndex = 0;
  dayData.forEach((pair, idx) => {
      const dentiste = pair.name;
      const assistante = pair.assistant;

      if (dentiste) {
          let room = allRooms[cabIndex % allRooms.length];
          cabIndex++;

          let dentistPerson = makePerson({suit:'#4dabf7', skin:pick(SKINS), hair:pick(HAIRS), badge:'🩺', name: 'Dr ' + dentiste});
          setPos(dentistPerson, room.dentistHome.x, room.dentistHome.y);

          let assistantPerson = null;
          if (estActif(assistante)) {
              assistantPerson = makePerson({suit:'#63e6be', skin:pick(SKINS), hair:pick(HAIRS), badge:'🧤', name: assistante + ' · Assistante'});
              setPos(assistantPerson, room.assistHome.x, room.assistHome.y);
          }

          staff.push({dentist: dentistPerson, assistant: assistantPerson});
          activeRooms.push(room);
      } else if (estActif(assistante)) {
          let assistantPerson = makePerson({suit:'#63e6be', skin:pick(SKINS), hair:pick(HAIRS), badge:'🧤', name: assistante + ' (Sté)'});
          setPos(assistantPerson, steCoords.x + (idx * 30 - 30), steCoords.y);
          standaloneStaff.push(assistantPerson);
      }
  });
}

syncPlanning();

// L'équipe change à 13 h et quand le planning est modifié : on recharge
// l'animation quand l'équipe à afficher n'est plus la même.
setInterval(async () => {
  const { cle } = equipeDuJour(await lirePlanning());
  if (equipeAffichee !== null && cle !== equipeAffichee) location.reload();
}, 5 * 60 * 1000);

/* ============================================================
   Simulation
============================================================ */
let speedMul = 1, paused = false, healed = 0, simTime = 0;
const patients = [];
const receptionQueue = [];
let receptionBusy = false;

const WALK_SPEED = 95;

class Patient {
  constructor(){
    this.name = pick(NAMES);
    this.el = makePerson({suit:pick(SUITS), skin:pick(SKINS), hair:pick(HAIRS), name:this.name+' · Patient'});
    setPos(this.el, ENTRANCE.x + (Math.random()*40-20), ENTRANCE.y);
    this.path = [];
    this.state = 'arriving';
    this.timer = 0;
    this.room = null;
    this.chairIdx = -1;
    this.goTo(DOOR_IN, ()=> this.joinReceptionQueue());
  }
  goTo(...args){
    const done = (typeof args[args.length-1]==='function') ? args.pop() : null;
    this.path = args.map(p=>({...p}));
    this.onArrive = done;
    this.el.classList.add('walking');
    this.el.classList.remove('idle');
  }
  update(dt){
    if(this.timer > 0){
      this.timer -= dt;
      if(this.timer <= 0 && this.afterTimer){ const f=this.afterTimer; this.afterTimer=null; f(); }
      return;
    }
    if(this.path.length===0) return;
    const t = this.path[0];
    const dx = t.x - this.el._x, dy = t.y - this.el._y;
    const dist = Math.hypot(dx,dy);
    const step = WALK_SPEED * dt;
    if(dist <= step){
      setPos(this.el, t.x, t.y);
      this.path.shift();
      if(this.path.length===0){
        this.el.classList.remove('walking');
        this.el.classList.add('idle');
        if(this.onArrive){ const f=this.onArrive; this.onArrive=null; f(); }
      }
    } else {
      setPos(this.el, this.el._x + dx/dist*step, this.el._y + dy/dist*step);
    }
  }
  wait(sec, then){ this.timer = sec; this.afterTimer = then; }

  joinReceptionQueue(){
    receptionQueue.push(this);
    updateQueuePositions();
  }
  talkToSecretary(){
    receptionBusy = true;
    const secretary = secretaries[0]; // main secretary
    this.goTo(RECEPTION_SPOT, ()=>{
      bubble(this.el, '👋 Bonjour !');
      setTimeout(()=>{ bubble(secretary, '🗓️ Un instant…'); secretary.classList.add('typing'); }, 900);
      this.wait(2.6, ()=>{
        secretary.classList.remove('typing');
        bubble(secretary, '🛋️ Patientez !');
        receptionBusy = false;
        this.goSit();
        updateQueuePositions();
      });
    });
  }
  goSit(){
    const c = WAIT_CHAIRS.find(c=>!c.taken);
    if(c){ 
      c.taken = true; this.chairIdx = WAIT_CHAIRS.indexOf(c);
      this.goTo({x:310, y:490}, {x:c.x, y:c.y}, ()=>{ this.state='waiting'; });
    } else {
      this.goTo({x:310, y:490}, WAIT_STAND_SPOT, ()=>{ this.state='waiting'; });
    }
  }
  enterRoom(room){
    this.state='toRoom';
    room.busy = true;
    room.occupant = this;
    this.room = room;
    if(this.chairIdx>=0){ WAIT_CHAIRS[this.chairIdx].taken=false; this.chairIdx=-1; }
    bubble(this.el, '😬 À moi !');
    this.goTo(...room.pathFromWait, room.door, room.inside, room.chair, ()=> this.startTreatment());
  }
  startTreatment(){
    this.state='treated';
    this.el.classList.remove('idle');
    this.el.classList.add('lying');
    const idx = activeRooms.indexOf(this.room);
    const {dentist, assistant} = staff[idx];
    
    if (dentist) {
        movePersonTo(dentist, this.room.dentistWork, ()=>{
          dentist.classList.add('working');
          bubble(dentist, '🪥 Ouvrez grand !');
        });
    }
    if (assistant) {
        movePersonTo(assistant, this.room.assistWork, ()=>{
          assistant.classList.add('assisting');
          setTimeout(()=> bubble(assistant, '💧 Aspiration…'), 1200);
        });
    }
    
    const dur = 5.5 + Math.random()*3;
    this._sparkler = setInterval(()=>{
      if(!paused) sparkleAt(this.room.chair.x, this.room.chair.y-10);
    }, 450);
    this.wait(dur, ()=> this.finishTreatment());
  }
  finishTreatment(){
    clearInterval(this._sparkler);
    const idx = activeRooms.indexOf(this.room);
    const {dentist, assistant} = staff[idx];
    
    if(dentist) {
        dentist.classList.remove('working');
        bubble(dentist, '✅ Parfait !');
        movePersonTo(dentist, this.room.dentistHome);
    }
    if(assistant) {
        assistant.classList.remove('assisting');
        movePersonTo(assistant, this.room.assistHome);
    }
    
    this.el.classList.remove('lying');
    this.el.classList.add('idle');
    bubble(this.el, '😁 Merci !', 2000);
    healed++;
    document.getElementById('counter').textContent = '😁 Patients soignés : ' + healed;
    
    const room = this.room;
    this.wait(1.4, ()=>{
      this.goTo(room.inside, room.door, ...[...room.pathFromWait].reverse(), DOOR_IN, ENTRANCE, ()=>{
        if(room.occupant === this){
          room.busy = false;
          room.occupant = null;
        }
        this.remove();
      });
    });
  }
  remove(){
    this.el.remove();
    const i = patients.indexOf(this);
    if(i>=0) patients.splice(i,1);
  }
}

function movePersonTo(p, target, done){
  p._move = {target, done};
  p.classList.add('walking'); p.classList.remove('idle');
}
function updateStaff(dt){
  const all = [...secretaries, ...standaloneStaff];
  staff.forEach(s => {
      if(s.dentist) all.push(s.dentist);
      if(s.assistant) all.push(s.assistant);
  });
  for(const p of all){
    if(!p._move) continue;
    const {target, done} = p._move;
    const dx=target.x-p._x, dy=target.y-p._y, dist=Math.hypot(dx,dy);
    const step = WALK_SPEED*dt;
    if(dist<=step){
      setPos(p,target.x,target.y);
      p._move=null; p.classList.remove('walking'); p.classList.add('idle');
      if(done) done();
    } else setPos(p, p._x+dx/dist*step, p._y+dy/dist*step);
  }
}

function updateQueuePositions(){
  receptionQueue.forEach((pat,i)=>{
    if(i===0 && !receptionBusy && pat.state==='arriving'){
      pat.state='reception';
      receptionQueue.shift();
      pat.talkToSecretary();
    } else if(pat.state==='arriving'){
      const spot = QUEUE_SPOTS[Math.min(i-1<0?0:i-1, QUEUE_SPOTS.length-1)];
      pat.goTo(spot);
    }
  });
}

/* ---------- main loop ---------- */
let last = performance.now();
let nextSpawn = 1.0;

function tick(now){
  const rawDt = Math.min((now-last)/1000, .05);
  last = now;
  if(!paused){
    const dt = rawDt * speedMul;
    simTime += dt;

    nextSpawn -= dt;
    if(nextSpawn<=0 && patients.length < (activeRooms.length * 2 + 6)){
      patients.push(new Patient());
      nextSpawn = 4.5 + Math.random()*4;
    }

    if(!receptionBusy && receptionQueue.length) updateQueuePositions();

    const freeRoom = activeRooms.find(r=>!r.busy && !r.occupant);
    if(freeRoom){
      const next = patients.find(p=>p.state==='waiting');
      if(next) next.enterRoom(freeRoom);
    }

    patients.forEach(p=>p.update(dt));
    updateStaff(dt);

    if(Math.random()<dt*0.15) bubble(secretaries[0], pick(['☎️','📋','🗓️','☕']), 1200);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

/* ---------- controls ---------- */
document.getElementById('btn-pause').addEventListener('click', e=>{
  paused = !paused;
  e.target.textContent = paused ? '▶️ Reprendre' : '⏸️ Pause';
});
document.getElementById('speed').addEventListener('input', e=>{
  speedMul = parseFloat(e.target.value);
});
