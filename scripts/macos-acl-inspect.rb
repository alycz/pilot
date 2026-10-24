#!/usr/bin/ruby
# frozen_string_literal: true

require 'fiddle'

begin
  file = ARGV.length == 1 ? File.open(ARGV.fetch(0), File::RDONLY | File::NOFOLLOW) : nil
  exit 64 unless file
rescue SystemCallError
  exit 65
end

handle = Fiddle::Handle::DEFAULT
acl_get_fd_np = Fiddle::Function.new(handle['acl_get_fd_np'], [Fiddle::TYPE_INT, Fiddle::TYPE_INT], Fiddle::TYPE_VOIDP)
acl_to_text = Fiddle::Function.new(handle['acl_to_text'], [Fiddle::TYPE_VOIDP, Fiddle::TYPE_VOIDP], Fiddle::TYPE_VOIDP)
acl_get_entry = Fiddle::Function.new(handle['acl_get_entry'], [Fiddle::TYPE_VOIDP, Fiddle::TYPE_INT, Fiddle::TYPE_VOIDP], Fiddle::TYPE_INT)
acl_get_tag_type = Fiddle::Function.new(handle['acl_get_tag_type'], [Fiddle::TYPE_VOIDP, Fiddle::TYPE_VOIDP], Fiddle::TYPE_INT)
acl_free = Fiddle::Function.new(handle['acl_free'], [Fiddle::TYPE_VOIDP], Fiddle::TYPE_INT)

acl = acl_get_fd_np.call(file.fileno, 0x00000100)
retrieval_errno = Fiddle.last_error
if acl.to_i.zero?
  exit 66 unless file.close.nil?
  if retrieval_errno == Errno::ENOENT::Errno
    puts 'EMPTY'
    exit 0
  end
  exit 67
end

text_pointer = acl_to_text.call(acl, 0)
if text_pointer.to_i.zero?
  acl_free.call(acl)
  file.close
  exit 68
end

text = Fiddle::Pointer.new(text_pointer).to_s
exit 69 unless acl_free.call(text_pointer).zero?
lines = text.lines(chomp: true)
exit 70 unless lines.shift == '!#acl 1' && !lines.empty?

access_granting = false
entry_pointer = Fiddle::Pointer.malloc(Fiddle::SIZEOF_VOIDP)
tag_pointer = Fiddle::Pointer.malloc(Fiddle::SIZEOF_INT)
lines.each_with_index do |entry, index|
  fields = entry.split(':', 6)
  exit 71 unless fields.length == 6 && %w[user group].include?(fields.fetch(0))
  exit 72 unless fields.fetch(1).match?(/\A[0-9A-Fa-f-]{36}\z/)
  exit 73 unless fields.fetch(3).match?(/\A\d+\z/)
  exit 74 unless acl_get_entry.call(acl, index, entry_pointer).zero?
  native_entry = entry_pointer[0, Fiddle::SIZEOF_VOIDP].unpack1('J')
  exit 75 if native_entry.nil? || native_entry.zero?
  exit 76 unless acl_get_tag_type.call(native_entry, tag_pointer).zero?
  case tag_pointer[0, Fiddle::SIZEOF_INT].unpack1('i!')
  when 1 then access_granting = true
  when 2 then nil
  else exit 77
  end
  exit 78 unless fields.fetch(5).match?(/\A[a-z_]+(?:,[a-z_]+)*\z/)
end

exit 79 unless acl_free.call(acl).zero? && file.close.nil?
puts(access_granting ? 'ACCESS_GRANTING' : 'DENY_ONLY')
