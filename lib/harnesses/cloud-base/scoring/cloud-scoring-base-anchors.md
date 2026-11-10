## Anchors (example user: software engineer in Amsterdam building an AI news app; parents in Bhopal and currently traveling in Chhindwara; partner's family in Porto Santo; Berlin trip next weekend; interests: journalism+AI, privacy-safe AI, on-device small language models, tech/journalism conferences; NO investments)
FEED:
- 1.05 "Flooding evacuation ordered in Amsterdam Nieuw-West" — home danger, act now
- 0.85 "Flash floods submerge low-lying areas of Bhopal, rescue teams deployed" — family-city disaster, loved ones at risk
- 0.75 "EU AI Act enforcement begins for consumer AI apps" — compliance for his own product
- 0.72 "Heavy-rain alert for Madhya Pradesh, incl. Chhindwara district" — region alert covering family city
- 0.68 "EU forces Google to open AI services to competitors" — structural platform ruling in his field
- 0.66 "Berlin public transport strike announced for the weekend" — trip city, trip dates
- 0.65 "Netherlands officially declares water shortage, measures needed" — national structural
- 0.62 "900 excess deaths during Netherlands heatwave, RIVM warns" — national structural health alert
- 0.62 "Publishers sue Google and Meta over AI training data" — AI-content legal terrain, his product space
- 0.60 "Startup lab founded by ex-OpenAI CTO releases first open-weight model" — usable release in his field
- 0.58 "Your AI chats may be exposed to other users, researchers find" — privacy-safe AI, named interest
- 0.58 "Madhya Pradesh monsoon update: heavy rain returns to the state" — state-wide weather covering family cities
- 0.55 "Berlin district Mitte bans mobile trade in the historic center" — trip-city rule a visitor meets
- 0.55 "June was hotter and drier than usual in Madeira" — family archipelago conditions
- 0.52 "Funchal praises canoe crossing between Porto Santo and Madeira" — family island region
- 0.49 "Double murder investigated in Bhopal" — routine individual crime in a family city, no wider risk to loved ones
- 0.48 "New glass-block house completed in Amsterdam Centrumeiland" — his city, ambient, nothing to act on
- 0.47 "1,500 CCTVs checked to solve Bhopal couple's murder" — family-city crime investigation, no area-wide danger
- 0.45 "Bhopal traders petition for mixed land-use change" — family-city civic news, minor
- 0.44 "ABVP protests Bhopal rape case, burns effigy in Dewas" — protest about a family-city crime, no wider risk
- 0.42 "Dutch developer conference announces speaker lineup" — attendable, minor
TANGENTIAL:
- 0.38 "How AI is transforming banking" — industry-category chatter, no stake
- 0.36 "Apple finally fixed Siri — your new favorite AI tool" — consumer-gadget AI feature, not his product space
- 0.35 "ASML raises forecasts as AI demand booms" — industry signal, no holdings, nothing to act on
- 0.35 "DeepMind CEO warns AGI is near, calls for global oversight body" — executive opinion, no concrete change
- 0.33 "EU accepts X's transparency plan after fine" — platform regulation, not his product type
- 0.32 "Indian AI startup becomes a unicorn" — origin + industry categories, no stake
- 0.32 "Five AI tools you can use from your phone" — tool listicle, no concrete change in his field
- 0.32 "5x fried chicken in Amsterdam to lick your fingers at" — own-city lifestyle listicle, nothing practical
- 0.30 "Berlin election poll shows shifting coalition" — trip city's domestic politics, not visitor info
- 0.30 "Berlin police get new forensic institute for 190 million" — trip city's local news, not visitor info
- 0.28 "Rotterdam council unexpectedly votes out alderman" — his country, but another city's local politics
- 0.28 "US DOJ subpoenas New York Times reporters" — journalism-category news, no AI/product/place stake
- 0.26 "Why founders burn out — an essay" — profession-adjacent think piece
EXCLUDE:
- 0.22 "Thunderstorm warning for Bavaria and Hesse" — trip is to Berlin; other regions' weather is not trip info
- 0.20 "Slovakia late transposing five EU directives" — foreign-domestic, no interest match
- 0.20 "Germany and Austria continue border controls" — border POLICY story, not a trip disruption
- 0.18 "EU commissioner calls for end to German border controls" — policy debate, no service change
- 0.18 "Country X passes national AI implementation framework" — another country's domestic AI policy, no stake
- 0.15 "Porto launches free public-transport card" — mainland Porto is NOT Porto Santo; no family tie
- 0.15 "Wall Street rises on tech gains" — market wrap, no holdings
- 0.12 "Ten passport errors that can ruin your vacation" — travel-tips listicle, not trip-specific
- 0.12 "Monsoon returns to Uttar Pradesh and Bihar" — origin country, NOT the family cities or their state
- 0.12 "Monsoon strengthens again in Chhattisgarh" — NEIGHBORING state of the family cities — does not cover them
- 0.10 "Building fire in Heald Green, Manchester UK" — foreign-city incident, no overlap
- 0.05 "AP Top Technology News at 3:43 p.m. EDT" — wire digest

Use the full continuous range with fine-grained values between anchors (0.47, 0.63, 0.71) — never round to .05/.10 increments. When torn between two tiers, re-run the stake test: a real stake means ≥ 0.40, no stake means < 0.40.


