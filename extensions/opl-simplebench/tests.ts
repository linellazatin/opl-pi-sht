export interface ReasoningFixture {
  name: string;
  prompt: string;
  expectedAnswer: string;
  category: string;
}

const finalAnswer = "Reason as needed. Put only the exact answer on your final line.";

export const REASONING_TESTS: ReasoningFixture[] = [
  { name: "snail_wall", prompt: `A snail climbs 3 feet each day and slides 2 feet each night. The wall is 10 feet tall. How many days until it first reaches the top? ${finalAnswer}`, expectedAnswer: "8", category: "logic" },
  { name: "math_sequence", prompt: `What is the next number: 2, 6, 18, 54, ? ${finalAnswer}`, expectedAnswer: "162", category: "math" },
  { name: "spatial_directions", prompt: `Face north. Turn 90 degrees clockwise, then 180 degrees counter-clockwise. Which direction are you facing? ${finalAnswer}`, expectedAnswer: "west", category: "spatial" },
  { name: "commonsense", prompt: `Can a rooster lay an egg? Answer with a yes or a no only. ${finalAnswer}`, expectedAnswer: "no", category: "commonsense" },
  { name: "code_simplify", prompt: `What is x after: let x = 0; for (let i = 1; i <= 5; i++) x += i; ${finalAnswer}`, expectedAnswer: "15", category: "code" },
  { name: "bat_and_ball", prompt: `A bat and ball cost 110 cents. The bat costs 100 cents more than the ball. How many cents does the ball cost? Answer with digits only. ${finalAnswer}`, expectedAnswer: "5", category: "counterint" },
  { name: "scale_weight", prompt: `One weight is 100 grams. Another is four times as heavy. How many grams does the second weigh? Answer with digits only. ${finalAnswer}`, expectedAnswer: "400", category: "counterint" },
  { name: "syllogism", prompt: `All mammals are warm-blooded. All dogs are mammals. What property do all dogs have? Answer exactly: warm-blooded. ${finalAnswer}`, expectedAnswer: "warm-blooded", category: "logic" },
  { name: "if_then_chain", prompt: `If it rains, the ground gets wet. If the ground gets wet, grass grows. It is raining. What happens to the grass? Answer exactly: grass grows. ${finalAnswer}`, expectedAnswer: "grass grows", category: "logic" },
  { name: "cause_effect", prompt: `A tomato plant produces 4 tomatoes each day for 3 days. How many tomatoes does it produce? Answer with digits only. ${finalAnswer}`, expectedAnswer: "12", category: "causal" },
  { name: "relative_quantities", prompt: `Tom has three times as many apples as Sara. Sara has five apples. How many apples does Tom have? Answer with digits only. ${finalAnswer}`, expectedAnswer: "15", category: "comparative" },
  { name: "analogy_1", prompt: `Use the explicitly stated relationship “is the capital city of”: Paris is to France as Tokyo is to which country? Answer exactly one word: Japan or China. Reason as needed. Put only the exact answer on your final line. ${finalAnswer}`, expectedAnswer: "japan", category: "analogy" },
  { name: "analogy_2", prompt: `3 is to 6 as 5 is to what number? ${finalAnswer}`, expectedAnswer: "10", category: "analogy" },
  { name: "physics_1", prompt: `Which has more mass? Answer exactly: bowling ball or tennis ball. ${finalAnswer}`, expectedAnswer: "bowling ball", category: "commonsense" },
  { name: "physics_2", prompt: `Compared with before heating, is a metal spoon hotter or colder after it is heated? ${finalAnswer}`, expectedAnswer: "hotter", category: "commonsense" },
  { name: "objects_1", prompt: `What tool cuts paper? ${finalAnswer}`, expectedAnswer: "scissors", category: "commonsense" },
  { name: "social_1", prompt: `Someone says please and thank you. Are they polite or rude? Answer polite or rude. ${finalAnswer}`, expectedAnswer: "polite", category: "commonsense" },
  { name: "animals_1", prompt: `Dolphins live in water, not on land. Answer exactly: water or land. ${finalAnswer}`, expectedAnswer: "water", category: "commonsense" },
  { name: "gk_1", prompt: `Which planet is known as the Red Planet? ${finalAnswer}`, expectedAnswer: "mars", category: "commonsense" },
  { name: "gk_2", prompt: `How many days are in a leap year? ${finalAnswer}`, expectedAnswer: "366", category: "commonsense" },
];

export const MULTISTEP_INSTRUCTION = `Respond with only this JSON object, with no Markdown or explanation:
{"operation":"status","requestId":"bench-42","ok":true}`;

export const CALC_TOOL_DEFINITION = {
  type: "function" as const,
  function: { name: "calculate", description: "Perform a mathematical calculation", parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } },
};
