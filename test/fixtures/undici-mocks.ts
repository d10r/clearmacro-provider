import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";

export function installMockAgent() {
  const previousDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  return {
    mockAgent,
    restore() {
      setGlobalDispatcher(previousDispatcher);
      void mockAgent.close();
    },
  };
}
