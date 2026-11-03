// The faint example behind a fresh chat: what people tell Mera (the welcome) or
// what they follow (Follow a story). English source; ChatSample translates it.
// Owner rule: the profile holds broad things with news behind them; a single
// named artist, team, person or event is a story to follow, never a fact.
// The trending names date: refresh them by OTA, no native build needed.

const LIVE = [
  'I live in the Jordaan, Amsterdam', 'I live in De Pijp, Amsterdam', 'I live in Utrecht', 'I live in Rotterdam Noord',
  'I live in Shoreditch, London', 'I live in Peckham, London', 'I live in Didsbury, Manchester', 'I live in Leith, Edinburgh',
  'I live in Clifton, Bristol', 'I live in Kreuzberg, Berlin', 'I live in Schwabing, Munich', 'I live in Ehrenfeld, Cologne',
  'I live in Le Marais, Paris', 'I live in Croix-Rousse, Lyon', 'I live in Gràcia, Barcelona', 'I live in Malasaña, Madrid',
  'I live in Alfama, Lisbon', 'I live in Cedofeita, Porto', 'I live in Trastevere, Rome', 'I live in Navigli, Milan',
  'I live in Vesterbro, Copenhagen', 'I live in Södermalm, Stockholm', 'I live in Kallio, Helsinki', 'I live in Grünerløkka, Oslo',
  'I live in Ixelles, Brussels', 'I live in Antwerp', 'I live in Neubau, Vienna', 'I live in Żoliborz, Warsaw',
  'I live in Kazimierz, Kraków', 'I live in Vinohrady, Prague', 'I live in Kadıköy, Istanbul', 'I live in Bandra, Mumbai',
  'I live in Indiranagar, Bengaluru', 'I live in Hauz Khas, Delhi', 'I live in Salt Lake, Kolkata', 'I live in Banjara Hills, Hyderabad',
  'I live in Adyar, Chennai', 'I live in Kothrud, Pune', 'I live in Shimokitazawa, Tokyo', 'I live in Itaewon, Seoul',
  'I live in Tiong Bahru, Singapore', 'I live in Sukhumvit, Bangkok', 'I live in Makati, Manila', 'I live in Fitzroy, Melbourne',
  'I live in Surry Hills, Sydney', 'I live in Ponsonby, Auckland', 'I live in Brooklyn, New York', 'I live in the Mission, San Francisco',
  'I live in Silver Lake, Los Angeles', 'I live in Wicker Park, Chicago', 'I live in East Austin', 'I live in Capitol Hill, Seattle',
  'I live in Plateau Mont-Royal, Montreal', 'I live in Kensington Market, Toronto', 'I live in Kitsilano, Vancouver', 'I live in Roma Norte, Mexico City',
  'I live in Palermo, Buenos Aires', 'I live in Vila Madalena, São Paulo', 'I live in Lekki, Lagos', 'I live in Westlands, Nairobi',
  'I live in Woodstock, Cape Town', 'I live in Maboneng, Johannesburg', 'I live in Zamalek, Cairo', 'I live in Jumeirah, Dubai',
];

const WORK = [
  'I work as a software engineer', 'I work as a product designer', 'I work as a data analyst', 'I work in cybersecurity',
  'I work as a nurse', 'I’m a GP', 'I work as a pharmacist', 'I’m a physiotherapist', 'I work as a midwife', 'I’m a dentist',
  'I teach at a primary school', 'I teach maths at a secondary school', 'I’m a university lecturer', 'I’m a PhD student',
  'I work as an accountant', 'I work in banking', 'I work in insurance', 'I’m a lawyer', 'I work in HR', 'I’m a recruiter',
  'I work in marketing', 'I’m a copywriter', 'I work in PR', 'I’m a journalist', 'I’m a photographer', 'I’m a graphic designer',
  'I’m an architect', 'I’m a civil engineer', 'I’m an electrician', 'I’m a plumber', 'I work in construction',
  'I’m a chef', 'I run a small café', 'I work in hospitality', 'I drive for a delivery company', 'I’m a bus driver',
  'I work in logistics', 'I work at the port', 'I’m a pilot', 'I’m cabin crew', 'I work in retail', 'I run a shop',
  'I’m a hairdresser', 'I’m a personal trainer', 'I work for the council', 'I’m a civil servant', 'I work for an NGO',
  'I’m a social worker', 'I work in a care home', 'I’m a farmer', 'I work in renewable energy', 'I’m a mechanic',
  'I work in a factory', 'I’m a lab technician', 'I’m a musician', 'I work in film', 'I’m a freelance translator',
  'I run my own startup', 'I’m a student', 'I’m retired', 'I work in real estate', 'I’m a police officer', 'I’m a firefighter',
];

const FROM = [
  'I’m from Rotterdam', 'I’m from Groningen', 'I’m from Glasgow', 'I’m from Cork', 'I’m from Belfast', 'I’m from Leeds',
  'I’m from Hamburg', 'I’m from Marseille', 'I’m from Seville', 'I’m from Naples', 'I’m from Thessaloniki', 'I’m from Gdańsk',
  'I’m from Cluj', 'I’m from Izmir', 'I’m from Kyiv', 'I’m from Tbilisi', 'I’m from Tehran', 'I’m from Beirut',
  'I’m from Amman', 'I’m from Casablanca', 'I’m from Tunis', 'I’m from Accra', 'I’m from Lagos', 'I’m from Addis Ababa',
  'I’m from Kerala', 'I’m from Punjab', 'I’m from Bhopal', 'I’m from Jaipur', 'I’m from Lahore', 'I’m from Karachi',
  'I’m from Dhaka', 'I’m from Colombo', 'I’m from Kathmandu', 'I’m from Hanoi', 'I’m from Jakarta', 'I’m from Cebu',
  'I’m from Osaka', 'I’m from Busan', 'I’m from Taipei', 'I’m from Chengdu', 'I’m from Hong Kong', 'I’m from Perth',
  'I’m from Christchurch', 'I’m from Texas', 'I’m from Puerto Rico', 'I’m from Quebec', 'I’m from Medellín', 'I’m from Lima',
  'I’m from Santiago', 'I’m from Recife', 'I’m from Suriname', 'I’m from Curaçao',
];

const TRAVEL = [
  'I’m currently travelling through Japan', 'I’m currently in Kyoto', 'I’m currently backpacking in Vietnam', 'I’m currently in Lisbon for work',
  'I’m currently travelling around Morocco', 'I’m currently in Cape Town', 'I’m currently road-tripping in Iceland', 'I’m currently in Bali',
  'I’m currently travelling in Peru', 'I’m currently in Mexico City', 'I’m currently island-hopping in Greece', 'I’m currently in Seoul',
  'I’m currently travelling in Sri Lanka', 'I’m currently in New York', 'I’m currently in the Scottish Highlands', 'I’m currently in Istanbul',
  'I’m currently travelling through Patagonia', 'I’m currently in Marrakech', 'I’m currently in Hanoi', 'I’m currently in Copenhagen',
  'I’m going to Tokyo next month', 'I’m going to Patagonia in December', 'I’m going to the Amalfi Coast this summer', 'I’m going to New Zealand in January',
  'I’m going to Kenya on safari', 'I’m going to Lapland for Christmas', 'I’m going to Rio for Carnival', 'I’m going to Machu Picchu in spring',
  'I’m going to Cappadocia soon', 'I’m going to the Maldives in February', 'I’m going to Banff to ski', 'I’m going to Jordan to see Petra',
  'I’m going to Hoi An next week', 'I’m going to the Norwegian fjords', 'I’m going to Zanzibar in March', 'I’m going to Buenos Aires for the tango',
  'I’m going to Kerala in the new year', 'I’m going to the Faroe Islands', 'I’m going to Vancouver Island', 'I’m going to Oaxaca for Día de Muertos',
];

const SPORTS = [
  'I’m into Formula 1', 'I’m into MotoGP', 'I’m into motorsport', 'I’m into European football', 'I’m into Dutch football',
  'I’m into the Premier League', 'I’m into La Liga', 'I’m into Serie A', 'I’m into the Bundesliga', 'I’m into basketball',
  'I’m into American football', 'I’m into college sports', 'I’m into ice hockey', 'I’m into baseball', 'I’m into tennis',
  'I’m into darts', 'I’m into MMA', 'I’m into boxing', 'I’m into cricket', 'I’m into the IPL', 'I’m into women’s football',
  'I’m into rugby', 'I’m into golf', 'I’m into pickleball', 'I’m into padel', 'I’m into running and marathons',
  'I’m into road cycling', 'I’m into climbing', 'I’m into athletics', 'I’m into sailing', 'I’m into esports', 'I’m into chess',
  'I’m into the Olympics',
];

const MUSIC = [
  'I’m into pop music', 'I’m into Latin music', 'I’m into R&B', 'I’m into Afrobeats', 'I’m into K-pop', 'I’m into Bollywood music',
  'I’m into the UK grime scene', 'I’m into new music releases', 'I’m into the music industry', 'I’m into the Berlin techno scene',
  'I go to a lot of gigs in my city', 'I’m into jazz festivals', 'I love classical concerts', 'I’m into indie rock',
  'I’m into electronic music festivals', 'I love West End musicals', 'I’m into Eurovision', 'I’m into stadium tours',
  'I’m into the club scene in my city', 'I’m into reggaeton', 'I’m into metal festivals', 'I’m into music awards',
  'I’m into UK festivals', 'I’m into country music', 'I’m into hip-hop',
];

const INTERESTS = [
  'I love new book releases', 'I’m into literary prizes', 'I love trying new restaurants in my city', 'I’m into food markets near me',
  'I’m into Michelin restaurants', 'I’m into video games', 'I’m into new game releases', 'I love film festivals', 'I’m into awards season',
  'I’m into superhero films', 'I’m into space exploration', 'I’m into astronomy', 'I love new museum exhibitions',
  'I’m into contemporary art fairs', 'I’m into fashion weeks', 'I’m into sneaker drops', 'I love theatre premieres', 'I’m into true crime',
  'I’m into wildlife conservation', 'I’m into national parks', 'I’m into cycling routes in my city', 'I’m into electric cars',
  'I’m into new phones and gadgets', 'I’m into AI tools', 'I’m into architecture', 'I’m into archaeology finds', 'I’m into climate tech',
  'I’m into Formula E', 'I’m into local live music', 'I’m into street food festivals', 'I’m into Japanese anime', 'I’m into comedy specials',
  'I love bookshop events in my city', 'I’m into wine and new vintages',
];

// Written the way a followed story is named in the Followed stories list.
const STORIES = [
  'War in Ukraine', 'Gaza Ceasefire Talks', 'War in Sudan', 'US Midterm Results', '2028 US Presidential Race',
  'US Tariffs and Trade War', 'China and Taiwan Tensions', 'Iran Nuclear Talks', 'COP31 Climate Talks', 'Record Heatwaves',
  'Atlantic Hurricane Season', 'Artemis Moon Missions', 'SpaceX Starship Launches', 'EU AI Act Rollout', 'AI Chip Race',
  'ECB Interest Rates', 'Federal Reserve Rate Decisions', 'Dutch Housing Crisis', 'UK Cost of Living', 'NHS Waiting Lists',
  'India Economic Growth', 'Bird Flu Outbreaks', 'F1 Title Fight', 'Champions League Knockouts', 'Ajax Season',
  'Premier League Title Race', 'LA 2028 Olympics Preparations', 'UK and EU Relations', 'French Government Crisis', 'Channel Migrant Crossings',
  'Amazon Deforestation', 'Ocean Plastic Pollution', 'James Webb Telescope Discoveries', 'Quantum Computing Breakthroughs', 'Electric Cars in Europe',
  'Bitcoin Price Swings', 'Search for MH370', 'Arctic Sea Ice Decline', 'Mars Sample Return Mission', 'Global Chip Shortage',
  'Katseye', 'Olivia Rodrigo Tour Dates', 'Bad Bunny New Album', 'Taylor Swift', 'Tate McRae Tour',
  'Kimi Antonelli', 'Lakers Season', 'Arsenal Season', 'Mumbai Indians', 'Tour de France Route',
  'America’s Cup', 'Booker Prize Shortlist', 'Oscars Race', 'Chess World Championship', 'Glastonbury Tickets',
  'Eurovision 2027', 'Next Nintendo Console', 'Grammy Nominations', 'Ashes Squad Selection', 'Paris Agreement Targets',
];

export type ChatSampleKind = 'profile' | 'stories';

/** Deterministic Lehmer generator, so a seed always gives the same sample. */
function rng(seed: number): () => number {
  let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function pick(list: readonly string[], rand: () => number): string {
  return list[Math.floor(rand() * list.length)];
}

/** Six lines: home, work, roots or a trip, a sport, music, one more interest. */
export function sampleProfile(seed: number): string[] {
  const rand = rng(seed);
  const third = rand() < 0.5 ? pick(FROM, rand) : pick(TRAVEL, rand);
  return [pick(LIVE, rand), pick(WORK, rand), third, pick(SPORTS, rand), pick(MUSIC, rand), pick(INTERESTS, rand)];
}

/** Five distinct story names. */
export function sampleStories(seed: number): string[] {
  const rand = rng(seed);
  const out: string[] = [];
  while (out.length < 5) {
    const s = pick(STORIES, rand);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

export function sampleLines(kind: ChatSampleKind, seed: number): string[] {
  return kind === 'profile' ? sampleProfile(seed) : sampleStories(seed);
}

export const SAMPLE_LISTS = { LIVE, WORK, FROM, TRAVEL, SPORTS, MUSIC, INTERESTS, STORIES } as const;
