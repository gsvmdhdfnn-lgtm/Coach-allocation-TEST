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
/**
 * The easy-picker palette behind every Colour Preset dropdown in Airtable
 * (Public Pages, Organisation & Branding). Defined here rather than taken
 * from Airtable's own swatch colours, because Airtable's API only exposes
 * a colour NAME per choice (e.g. "blueBright"), not its hex - and that
 * native palette has no true white/black anyway. A Custom Colour (hex)
 * field always wins over the preset when both are set, everywhere this
 * is used - resolveColour() is the one place that rule lives.
 */
var COLOUR_PRESETS={
  'Navy':'#062a59','Royal Blue':'#1187ee','Sky Blue':'#52b9ef','Teal':'#0f8a82',
  'Forest Green':'#1d4a39','Grass Green':'#3d7a34','Lime':'#c8ed21','Sunshine Yellow':'#f5c518',
  'Amber':'#e6841f','Red':'#d94b5c','Pink':'#e0559c','Purple':'#7a4fd6',
  'Charcoal':'#1c2733','Slate Grey':'#55637a','White':'#ffffff','Black':'#000000'
};
function resolveColour(customHex,presetName){
  var hex=String(customHex||'').trim();
  if(hexToRgb(hex))return hex.charAt(0)==='#'?hex:'#'+hex;
  if(presetName&&COLOUR_PRESETS[presetName])return COLOUR_PRESETS[presetName];
  return '';
}
/**
 * Whatever colour ends up as the hero background or a hero button's fill,
 * its own text needs to stay readable against it - two Airtable presets
 * that happen to land on the same or a very light colour (Primary and
 * Secondary both "Sky Blue" did this for real, making the Register
 * button's text invisible against its own background) must never
 * produce invisible text. Same relative-luminance check the tiles
 * already use via contrastIsLight() in app.js, kept local here since
 * this file loads before app.js and the two aren't wired to share
 * helpers.
 */
function relLuminance(hex){
  var rgb=hexToRgb(hex);
  if(!rgb)return 1;
  var c=[rgb.r,rgb.g,rgb.b].map(function(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)});
  return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2];
}
function contrastRatio(hexA,hexB){
  var la=relLuminance(hexA)+0.05,lb=relLuminance(hexB)+0.05;
  return la>lb?la/lb:lb/la;
}
/**
 * Picking "dark ink on light bg, light ink on dark bg" from a single
 * luminance cutoff got a real mid-tone colour (Sky Blue, #52b9ef) wrong -
 * it read as "dark" by that test but still only gave cream text a 1.89:1
 * contrast ratio against it. Comparing the two candidates' actual
 * contrast ratios and picking the winner is correct regardless of where
 * a colour falls on the light/dark spectrum.
 */
function bestInk(hex){
  var dark='#0a2050',light='#f0f0c8';
  return contrastRatio(hex,dark)>=contrastRatio(hex,light)?dark:light;
}
function applyBrandColours(){
  var org=current.organisation||{};
  var root=document.documentElement.style;
  var primary=resolveColour(org.primary_colour,org.primary_colour_preset);
  var accent=resolveColour(org.accent_colour,org.accent_colour_preset);
  var secondary=resolveColour(org.secondary_colour,org.secondary_colour_preset);
  if(hexToRgb(primary)){
    root.setProperty('--navy',primary);
    root.setProperty('--navy-2',lighten(primary,0.22));
    root.setProperty('--navy-deep',darken(primary,0.12));
    root.setProperty('--navy-deepest',darken(primary,0.4));
    var themeMeta=document.querySelector('meta[name="theme-color"]');
    if(themeMeta)themeMeta.setAttribute('content',primary);
  }
  if(hexToRgb(accent)){
    root.setProperty('--blue',accent);
    root.setProperty('--blue-2',lighten(accent,0.28));
    var heroInk=bestInk(accent);
    root.setProperty('--hero-ink',heroInk);
    root.setProperty('--hero-shadow',heroInk==='#0a2050'?'rgba(255,255,255,.6)':'#061d3d');
  }
  if(hexToRgb(secondary)){
    root.setProperty('--lime',secondary);
    root.setProperty('--secondary-ink',bestInk(secondary));
  }
}
/**
 * Every logo image in the Hub (top bar, auth screens) ships as a bundled
 * je-logo.png in the markup so the app never shows a broken image before
 * data loads. Once Organisation & Branding's own Logo attachment resolves,
 * swap every one of those images over to it - a blank Logo field leaves
 * je-logo.png exactly as it was, so this is purely additive.
 */
function applyLogo(){
  var url=current.organisation&&current.organisation.logo_url;
  if(!url)return;
  document.querySelectorAll('.brand-lockup img, .auth-logo').forEach(function(img){
    if(img.src!==url)img.src=url;
  });
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
  applyLogo();
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
function apiCollection(path,token){
  var base=String(CFG.contentApiUrl||'').trim();
  if(!base)return Promise.resolve([]);
  var url=base.replace(/\/$/,'')+'/'+path.replace(/^\//,'');
  var headers={};
  if(token)headers.Authorization='Bearer '+token;
  return fetch(url,{cache:'no-store',credentials:'omit',headers:headers})
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
  loadWhatWeOffer:function(){return apiCollection('what-we-offer')},
  loadPlayers:function(token){return apiCollection('players',token)},
  loadFeedback:function(){return apiCollection('feedback')},
  loadDevelopmentPlans:function(){return apiCollection('development-plans')},
  resolveColour:resolveColour
};

var observer=new MutationObserver(function(){applyVisibleLabels()});
  observer.observe(document.body,{childList:true,subtree:true});

load();

})();
