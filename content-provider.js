(function(){
'use strict';

/*
  Josh Evans Hub — content provider
  ---------------------------------
  Purpose:
  Keep the Hub UI independent from where editable content is stored.

  Current behaviour:
  - Uses safe built-in defaults, so nothing in the current TEST Hub changes.
  - No Airtable API token is stored in the browser.
  - If APP_CONFIG.contentApiUrl is added later, the provider reads a secure
    backend endpoint and normalises its response for the Hub.

  Future secure flow:
  Hub -> secure backend endpoint -> Airtable

  Expected endpoint response:
  {
    "organisation": {
      "organisation_id": "ORG-JOSHEVANS",
      "organisation_name": "Josh Evans Coaching",
      "hub_name": "Josh Evans Hub",
      "tagline": "Better people make better players."
    },
    "settings": {
      "my_players_label": "My Players",
      "feedback_label": "Feedback",
      "idp_label": "IDP",
      "resources_label": "Resources",
      "coach_support_label": "Coach Support"
    },
    "features": {
      "resources": true,
      "venues": true,
      "coach_support": true,
      "player_feedback": true,
      "development_plans": true,
      "my_players": true
    }
  }
*/

var CFG=window.APP_CONFIG||{};

var defaults={
  organisation:{
    organisation_id:'ORG-JOSHEVANS',
    organisation_name:'Josh Evans Coaching',
    hub_name:'Josh Evans Hub',
    tagline:'Better people make better players.'
  },
  settings:{
    my_players_label:'My Players',
    feedback_label:'Feedback',
    idp_label:'IDP',
    resources_label:'Resources',
    coach_support_label:'Coach Support'
  },
  features:{
    resources:true,
    venues:true,
    coach_support:true,
    player_feedback:true,
    development_plans:true,
    my_players:true
  }
};

function merge(base,extra){
  var out={},k;
  for(k in base)out[k]=base[k];
  for(k in (extra||{}))out[k]=extra[k];
  return out;
}

function normalise(payload){
  payload=payload||{};
  return {
    organisation:merge(defaults.organisation,payload.organisation),
    settings:merge(defaults.settings,payload.settings),
    features:merge(defaults.features,payload.features)
  };
}

var current=normalise(null);
var listeners=[];

function label(key,fallback){
  return (current.settings&&current.settings[key])||fallback||key;
}

function feature(key){
  return !current.features||current.features[key]!==false;
}

function replaceExact(root,from,to){
  if(!root||!from||from===to)return;
  var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  var node;
  while((node=walker.nextNode())){
    if(node.nodeValue&&node.nodeValue.trim()===from){
      var lead=(node.nodeValue.match(/^\s*/)||[''])[0];
      var trail=(node.nodeValue.match(/\s*$/)||[''])[0];
      node.nodeValue=lead+to+trail;
    }
  }
}

/**
 * Whole-app brand colours, from Organisation & Branding -> Primary/
 * Secondary/Accent Colour (plain hex, same fields the app already reads
 * for the org name/logo). Every colour in styles.css is a CSS custom
 * property already, so setting these three on :root re-themes the whole
 * Hub - top bar, buttons, hero backgrounds, nav highlights - with no
 * extra fields to keep in sync. A lighter shade for each is derived
 * automatically so gradients still have depth from one hex each.
 */
function hexToRgb(hex){
  var h=String(hex||'').trim().replace(/^#/,'');
  if(h.length===3)h=h.split('').map(function(c){return c+c}).join('');
  if(!/^[0-9a-f]{6}$/i.test(h))return null;
  return {r:parseInt(h.slice(0,2),16),g:parseInt(h.slice(2,4),16),b:parseInt(h.slice(4,6),16)};
}
function lighten(hex,amount){
  var c=hexToRgb(hex);
  if(!c)return hex;
  var mix=function(v){return Math.round(v+(255-v)*amount)};
  return 'rgb('+mix(c.r)+','+mix(c.g)+','+mix(c.b)+')';
}
function darken(hex,amount){
  var c=hexToRgb(hex);
  if(!c)return hex;
  var mix=function(v){return Math.round(v*(1-amount))};
  return 'rgb('+mix(c.r)+','+mix(c.g)+','+mix(c.b)+')';
}
function applyBrandColours(){
  var org=current.organisation||{};
  var root=document.documentElement.style;
  if(hexToRgb(org.primary_colour)){
    root.setProperty('--navy',org.primary_colour);
    root.setProperty('--navy-2',lighten(org.primary_colour,0.22));
    root.setProperty('--navy-deep',darken(org.primary_colour,0.12));
    root.setProperty('--navy-deepest',darken(org.primary_colour,0.4));
    var themeMeta=document.querySelector('meta[name="theme-color"]');
    if(themeMeta)themeMeta.setAttribute('content',org.primary_colour);
  }
  if(hexToRgb(org.accent_colour)){
    root.setProperty('--blue',org.accent_colour);
    root.setProperty('--blue-2',lighten(org.accent_colour,0.28));
  }
  if(hexToRgb(org.secondary_colour)){
    root.setProperty('--lime',org.secondary_colour);
  }
}
function applyVisibleLabels(){
  var map=[
    ['Resources',label('resources_label','Resources')],
    ['Coach Support',label('coach_support_label','Coach Support')],
    ['My Players',label('my_players_label','My Players')],
    ['Feedback',label('feedback_label','Feedback')],
    ['IDP',label('idp_label','IDP')]
  ];
  map.forEach(function(pair){replaceExact(document.body,pair[0],pair[1])});
if(
  current.organisation &&
  current.organisation.hub_name &&
  document.title !== current.organisation.hub_name
){
  document.title=current.organisation.hub_name;
}
}

function notify(){
  listeners.slice().forEach(function(fn){
    try{fn(current)}catch(e){}
  });
  applyBrandColours();
  applyVisibleLabels();
}

function load(){
  var url=String(CFG.contentApiUrl||'').trim();

  if(!url){
    notify();
    return Promise.resolve(current);
  }

  return fetch(url,{cache:'no-store',credentials:'omit'})
    .then(function(r){
      if(!r.ok)throw new Error('Content API returned '+r.status);
      return r.json();
    })
    .then(function(data){
      current=normalise(data);
      notify();
      return current;
    })
    .catch(function(err){
      console.warn('Hub content API unavailable; using safe defaults.',err);
      notify();
      return current;
    });
}

/*
  These loaders are intentionally source-agnostic.
  As Resources, Venues, Players and Feedback are connected, app.js can call
  these names rather than talking directly to Airtable.
*/
function apiCollection(path){
  var base=String(CFG.contentApiUrl||'').trim();
  if(!base)return Promise.resolve([]);
  var url=base.replace(/\/$/,'')+'/'+path.replace(/^\//,'');
  return fetch(url,{cache:'no-store',credentials:'omit'})
    .then(function(r){
      if(!r.ok)throw new Error('Content API returned '+r.status);
      return r.json();
    });
}

window.HubContent={
  load:load,
  get:function(){return current},
  label:label,
  feature:feature,
  onChange:function(fn){if(typeof fn==='function')listeners.push(fn)},
  loadResources:function(){return apiCollection('resources')},
  loadVenues:function(){return apiCollection('venues')},
  loadCoachSupport:function(){return apiCollection('coach-support')},
  loadPublicPages:function(){return apiCollection('public-pages')},
  loadPlayers:function(){return apiCollection('players')},
  loadFeedback:function(){return apiCollection('feedback')},
  loadDevelopmentPlans:function(){return apiCollection('development-plans')}
};

var observer=new MutationObserver(function(){applyVisibleLabels()});
  observer.observe(document.body,{childList:true,subtree:true});

load();

})();
