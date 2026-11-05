import { handleVerificationModal } from '../../services/skawVerificationService.js';

export default {
  name: 'skaw_vf_registration',
  async execute(interaction, client, args = []) {
    return handleVerificationModal(interaction, client, args);
  },
};
