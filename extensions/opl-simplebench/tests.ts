export interface ReasoningFixture {
  name: string;
  prompt: string;
  expectedAnswer: string | string[];
  category: string;
}

export const REASONING_TESTS: ReasoningFixture[] = [
    // Original tests
    { name: "snail_wall", prompt: "A snail climbs 3 feet up a wall each day, but slides back 2 feet each night. The wall is 10 feet tall. How many days does it take the snail to reach the top? Think step by step. ANSWER: <number>", expectedAnswer: "8", category: "logic" },
    { name: "math_sequence", prompt: "What is the next number in this sequence: 2, 6, 18, 54, ? Think step by step. ANSWER: <number>", expectedAnswer: "162", category: "math" },
    { name: "spatial_directions", prompt: "If you face north, turn 90 degrees clockwise, then turn 180 degrees counter-clockwise without changing your position, which direction are you facing? ANSWER: <direction>", expectedAnswer: "west", category: "spatial" },
    { name: "commonsense", prompt: "Can a rooster lay an egg? Answer yes or no. ANSWER: <yes-or-no>", expectedAnswer: "no", category: "commonsense" },
    { name: "code_simplify", prompt: "What value will x have after this code runs: let x = 0; for(let i=1; i<=5; i++) x += i; ANSWER: <number>", expectedAnswer: "15", category: "code" },
    // Phase 2: Counter-intuitive reasoning
    { name: "bat_and_ball", prompt: "A bat and a ball cost $1.10 total. The bat costs $1 more than the ball. How much does the ball cost? Think step by step. ANSWER: <number> cents", expectedAnswer: "5", category: "counterint" },
    { name: "scale_weight", prompt: "A scale weight is 100g. A similar scale weight is 4 times as heavy. How much does the second one weigh? Answer in grams. ANSWER: <number>", expectedAnswer: "400", category: "counterint" },
    // Phase 2: Logical deduction
    { name: "syllogism", prompt: "All mammals are warm-blooded. All dogs are mammals. Therefore, what can we conclude about dogs? Answer with the conclusion. ANSWER: <conclusion>", expectedAnswer: "warm-blooded", category: "logic" },
    { name: "if_then_chain", prompt: "If it rains, the ground gets wet. If the ground gets wet, the grass grows. It is raining. What happens? Think step by step. ANSWER: <outcome>", expectedAnswer: "grass grows", category: "logic" },
    // Phase 2: Causal reasoning
    { name: "cause_effect", prompt: "If you plant a seed in good soil with water and sunlight, what happens? Think about cause and effect. ANSWER: <outcome>", expectedAnswer: ["grows", "grow", "germinate"], category: "causal" },
    // Phase 2: Comparative reasoning
    { name: "relative_quantities", prompt: "Tom has 3 times as many apples as Sara. Sara has 5 apples. How many apples does Tom have? ANSWER: <number>", expectedAnswer: "15", category: "comparative" },
    // Phase 2: Analogical reasoning
    { name: "analogy_1", prompt: "Book is to Shelf as Chair is to what? Think about relationships. ANSWER: <container>", expectedAnswer: "room", category: "analogy" },
    { name: "analogy_2", prompt: "Hand is to Glove as Foot is to what? ANSWER: <item>", expectedAnswer: ["boot", "sock", "shoe"], category: "analogy" },
    // Phase 2: Common sense (physical properties)
    { name: "physics_1", prompt: "Does a bowling ball or a tennis ball have more mass? ANSWER: <object>", expectedAnswer: "bowling ball", category: "commonsense" },
    { name: "physics_2", prompt: "What happens to a metal spoon when heated? It usually becomes...? ANSWER: <state>", expectedAnswer: "hot", category: "commonsense" },
    // Phase 2: Common sense (everyday objects)
    { name: "objects_1", prompt: "What tool would you use to cut paper? ANSWER: <tool>", expectedAnswer: "scissors", category: "commonsense" },
    // Phase 2: Common sense (social situations)
    { name: "social_1", prompt: "If someone says 'please' and 'thank you', they are usually considered...? ANSWER: <trait>", expectedAnswer: "polite", category: "commonsense" },
    // Phase 2: Common sense (animals/nature)
    { name: "animals_1", prompt: "What do dolphins live in? ANSWER: <environment>", expectedAnswer: ["water", "ocean", "sea"], category: "commonsense" },
    // Phase 2: General knowledge
    { name: "gk_1", prompt: "Which planet is known as the Red Planet? ANSWER: <planet>", expectedAnswer: "mars", category: "commonsense" },
    { name: "gk_2", prompt: "How many days are in a leap year? ANSWER: <number>", expectedAnswer: "366", category: "commonsense" },
  ];


export const MULTISTEP_INSTRUCTION = `You must respond with ONLY a valid JSON object. No markdown, no explanation.
The JSON object must have exactly these keys:
{
  "name": "<your model name>",
  "can_count": true,
  "sum": 42,
  "language": "English",
  "colors": ["red", "blue", "green"],
  "timestamp": "<current time in ISO format>"
}
Return only the JSON.`;

export const CALC_TOOL_DEFINITION = {
    type: "function" as const,
    function: { name: "calculate", description: "Perform a mathematical calculation", parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } },
  };
