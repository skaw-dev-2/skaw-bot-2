import { handleVerificationModal } from '../../services/skawVerificationService.js';

export default {
  name: 'skaw_vf_registration',
  async execute(interaction, client) {
    return handleVerificationModal(interaction, client);
  },
};
