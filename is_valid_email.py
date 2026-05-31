def is_valid_email(s):
    """Return True if s is a basic-format email 'local@domain.tld', else False."""
    if not isinstance(s, str) or not s:
        return False
    if any(ch.isspace() for ch in s):
        return False
    if s.count("@") != 1:
        return False

    local, domain = s.split("@")
    if not local or not domain:
        return False

    if "." not in domain:
        return False

    labels = domain.split(".")
    if any(not label for label in labels):
        return False

    tld = labels[-1]
    if not tld:
        return False

    return True
