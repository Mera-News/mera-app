// Questionnaire guide for on-device chat system prompt.
//
// Each level is fed to the LLM individually based on the user's current progress.
// Only the current level is included in the prompt to conserve context window.

export interface QuestionnaireAttribute {
    /** Stable ID — same across all app installs so facts share consistent identifiers. */
    id: string;
    /** Full attribute string shown to LLM (e.g. "location: neighborhood/area, city, and country"). */
    text: string;
}

export interface QuestionnaireLevel {
    level: number;
    category: string;
    attributes: QuestionnaireAttribute[];
}

export const TOTAL_LEVELS = 10;

export const questionnaireLevels: QuestionnaireLevel[] = [
    {
        level: 1,
        category: 'Core',
        attributes: [
            { id: 'q1_location', text: 'location: neighborhood/area, city, and country (preserve specifics)' },
            { id: 'q1_profession', text: 'profession: job role and industry' },
            { id: 'q1_topics', text: 'topics: general interests' },
        ],
    },

    {
        level: 2,
        category: 'Professional',
        attributes: [
            { id: 'q2_company', text: 'company: employer name' },
            { id: 'q2_competitors', text: 'competitors: competitor companies' },
            { id: 'q2_companies_tracking', text: 'companies_tracking: other companies they follow' },
            { id: 'q2_company_ticker', text: 'company_ticker: employer stock ticker (if public)' },
            { id: 'q2_seniority', text: 'seniority: career level (entry/mid/senior/lead/director/vp/c_suite/founder)' },
            { id: 'q2_company_stage', text: 'company_stage: startup/growth/public/enterprise/nonprofit' },
            { id: 'q2_sub_industry', text: 'sub_industry: specific niche' },
            { id: 'q2_technologies_following', text: 'technologies_following: tech/platforms they follow' },
            { id: 'q2_skills_developing', text: 'skills_developing: skills they\'re learning' },
        ],
    },

    {
        level: 3,
        category: 'Financial',
        attributes: [
            { id: 'q3_stocks_held', text: 'stocks_held: individual stocks owned' },
            { id: 'q3_crypto_held', text: 'crypto_held: cryptocurrencies held' },
            { id: 'q3_etfs_held', text: 'etfs_held: ETFs in portfolio' },
            { id: 'q3_watchlist', text: 'watchlist: securities watching' },
            { id: 'q3_sectors_interested', text: 'sectors_interested: market sectors of interest' },
            { id: 'q3_risk_tolerance', text: 'risk_tolerance: conservative/moderate/aggressive' },
        ],
    },

    {
        level: 4,
        category: 'Civic & Local',
        attributes: [
            { id: 'q4_neighborhood', text: 'neighborhood: where they live locally' },
            { id: 'q4_state_province', text: 'state_province: state or province' },
            { id: 'q4_voting_jurisdiction', text: 'voting_jurisdiction: where they vote' },
            { id: 'q4_political_leaning', text: 'political_leaning: left/center_left/center/center_right/right/apolitical' },
            { id: 'q4_issues_cared_about', text: 'issues_cared_about: policy issues' },
            { id: 'q4_officials_tracking', text: 'officials_tracking: politicians they follow' },
            { id: 'q4_causes_supported', text: 'causes_supported: causes/movements' },
        ],
    },

    {
        level: 5,
        category: 'Relationships',
        attributes: [
            { id: 'q5_partner', text: 'partner: industry, city, interests' },
            { id: 'q5_children', text: 'children: age group, school, interests' },
            { id: 'q5_parents_location', text: 'parents_location: where parents live' },
            { id: 'q5_parents_health_topics', text: 'parents_health_topics: health conditions monitored' },
            { id: 'q5_family_locations', text: 'family_locations: extended family locations' },
        ],
    },

    {
        level: 6,
        category: 'Lifestyle',
        attributes: [
            { id: 'q6_hobbies', text: 'hobbies: their hobbies' },
            { id: 'q6_sports_playing', text: 'sports_playing: sports they play' },
            { id: 'q6_teams_following', text: 'teams_following: teams + sport' },
            { id: 'q6_entertainment_genres', text: 'entertainment_genres: preferred genres' },
            { id: 'q6_artists_creators_following', text: 'artists_creators_following: artists/creators they follow' },
        ],
    },

    {
        level: 7,
        category: 'Extended Context',
        attributes: [
            { id: 'q7_secondary_location', text: 'secondary_location: second home or frequent location' },
            { id: 'q7_cities_connected_to', text: 'cities_connected_to: personal ties to other cities' },
            { id: 'q7_frequent_destinations', text: 'frequent_destinations: frequent travel' },
            { id: 'q7_planned_travel', text: 'planned_travel: upcoming trips' },
            { id: 'q7_passport_countries', text: 'passport_countries: passports held' },
            { id: 'q7_nationality', text: 'nationality: nationalities' },
            { id: 'q7_alma_maters', text: 'alma_maters: where they studied' },
            { id: 'q7_fields_studied', text: 'fields_studied: what they studied' },
            { id: 'q7_topics_learning', text: 'topics_learning: currently learning' },
        ],
    },

    {
        level: 8,
        category: 'Health & Legal',
        attributes: [
            { id: 'q8_health_conditions_monitoring', text: 'health_conditions_monitoring: conditions they track' },
            { id: 'q8_wellness_interests', text: 'wellness_interests: wellness topics' },
            { id: 'q8_visa_countries', text: 'visa_countries: visa countries' },
            { id: 'q8_professional_licenses', text: 'professional_licenses: licenses held' },
            { id: 'q8_regulatory_bodies_affecting', text: 'regulatory_bodies_affecting: relevant regulators' },
            { id: 'q8_ev_owner', text: 'ev_owner: electric vehicle owner' },
            { id: 'q8_property_locations', text: 'property_locations: property owned, where' },
        ],
    },

    {
        level: 9,
        category: 'Side Ventures',
        attributes: [
            { id: 'q9_ventures', text: 'ventures: side businesses (name + industry)' },
            { id: 'q9_thought_leaders_following', text: 'thought_leaders_following: thought leaders' },
            { id: 'q9_career_target_industry', text: 'career_target_industry: aspired industry' },
        ],
    },

    {
        level: 10,
        category: 'Fine-tuning',
        attributes: [
            { id: 'q10_trusted_outlets', text: 'trusted_outlets: trusted news sources' },
            { id: 'q10_blocked_outlets', text: 'blocked_outlets: sources to avoid' },
            { id: 'q10_preferred_perspectives', text: 'preferred_perspectives: left_only/left_center/center/center_right/right_only/all' },
            { id: 'q10_entities_tracking', text: 'entities_tracking: specific people, products, legislation, scientific topics, geopolitical regions' },
            { id: 'q10_topic_intents', text: 'topic_intents: per-topic depth (headlines/summaries/deep_dive)' },
        ],
    },
];

/**
 * Builds a lookup map from attribute text → stable ID for all questionnaire levels.
 */
export function buildAttributeTextToIdMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const level of questionnaireLevels) {
        for (const attr of level.attributes) {
            map.set(attr.text, attr.id);
        }
    }
    return map;
}

/**
 * Builds a lookup map from stable ID → attribute text for all questionnaire levels.
 */
export function buildIdToAttributeTextMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const level of questionnaireLevels) {
        for (const attr of level.attributes) {
            map.set(attr.id, attr.text);
        }
    }
    return map;
}

/**
 * Extracts the attribute key (text before the colon) from an attribute string.
 * e.g., "location: neighborhood/area, city" → "location"
 */
export function parseAttributeKey(attributeString: string): string {
    const colonIdx = attributeString.indexOf(':');
    return colonIdx >= 0 ? attributeString.substring(0, colonIdx).trim() : attributeString.trim();
}

/**
 * Returns all attribute keys for a given level.
 */
export function getAttributeKeysForLevel(level: number): string[] {
    const levelData = questionnaireLevels.find((l) => l.level === level);
    if (!levelData) return [];
    return levelData.attributes.map((attr) => parseAttributeKey(attr.text));
}

/**
 * Builds the questionnaire guide string for the system prompt.
 * Includes only the current level to conserve context window.
 * When coveredAttributes is provided, annotates each attribute as [DONE] or [ASK].
 */
export function buildQuestionnaireGuide(
    currentLevel: number,
    coveredAttributes?: Set<string>,
): string {
    const current = questionnaireLevels.find((l) => l.level === currentLevel);
    if (!current) return '';

    const lines = current.attributes.map((attr) => {
        const key = parseAttributeKey(attr.text);
        if (coveredAttributes && coveredAttributes.has(key)) {
            return `- ${attr.text} [DONE] SKIP`;
        }
        return `- ${attr.text} [ASK]`;
    });

    return `### Level ${current.level}: ${current.category}\n${lines.join('\n')}`;
}
